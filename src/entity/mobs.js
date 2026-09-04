// ============================================================================
// mobs.js - The mob registry and the Mob entity class.
//
// Every creature in the game is one entry in MOBS plus one Mob instance. The
// definition holds the numbers (size, health, damage, drops, spawn rules) and
// the hooks (onTick / onAttack / onDeath / onInteract); the Mob class owns the
// behaviour that every mob shares - baby scaling, daylight burning, panic,
// taming, breeding, leashing, equipment, persistence and death.
//
// Movement and target selection live in entity/ai.js: each definition names a
// list of goals and the Mob wires an AIController from it. Goal implementations
// read `mob.def` for the per-mob knobs (tempts, breedItems, avoids, targets).
// ============================================================================

import { Game } from '../core/game.js';
import { clamp, prettyName, angleDiff } from '../core/util.js';
import { RNG } from '../core/rng.js';
import {
  DIFFICULTY, DIM_OVERWORLD, DIM_NETHER, DIM_END, WORLD_HEIGHT, MAX_LIGHT,
} from '../core/constants.js';
import { LivingEntity } from './entity.js';
import { AIController } from './ai.js';
import { blockByName, getBlock } from '../world/blocks.js';
import { BIOMES, biomeByName } from '../world/biomes.js';
import { itemExists } from '../item/items.js';

// ---------------------------------------------------------------------------
// Optional sibling modules.
//
// projectiles / combat / itementity are written by other passes and can import
// this file back, so they are pulled in lazily. The promises settle long before
// a mob ever ticks; every call site degrades gracefully if one is missing.
// ---------------------------------------------------------------------------
const MOD = { projectiles: null, combat: null, itementity: null };
let _depsStarted = false;

function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, key) => {
    try { import(path).then((m) => { MOD[key] = m; }).catch(() => { /* optional */ }); } catch { /* no dynamic import */ }
  };
  grab('./projectiles.js', 'projectiles');
  grab('./combat.js', 'combat');
  grab('./itementity.js', 'itementity');
}
loadDeps();

// ---------------------------------------------------------------------------
// Tiny shared helpers
// ---------------------------------------------------------------------------

/** Numeric block id for a name, or 0 when the name is unknown. */
function bid(name) {
  const d = blockByName(name);
  return d ? d.id : 0;
}

/** A bare item stack. `null` means "nothing"; extra fields are merged in. */
function mkStack(item, count = 1, extra = null) {
  const s = { item, count, damage: 0 };
  if (extra) Object.assign(s, extra);
  return s;
}

/** Plays a positional sound if the audio engine is up. Never throws. */
function playAt(world, name, x, y, z, vol = 1, pitch = 1) {
  if (!name) return;
  try { Game.audio?.playAt?.(name, x, y, z, vol, pitch); } catch { /* audio is optional */ }
}

/** Spawns particles if the particle system is up. Never throws. */
function particles(type, x, y, z, opts) {
  try { Game.particles?.spawn?.(type, x, y, z, opts || {}); } catch { /* optional */ }
}

/** Builds a damage source, preferring combat.js's canonical shape. */
function srcOf(type, entity = null, direct = null) {
  const c = MOD.combat;
  if (c && typeof c.damageSource === 'function') {
    try { return c.damageSource(type, entity, direct); } catch { /* fall through */ }
  }
  return {
    type, entity, direct, amount: 0,
    bypassArmor: type === 'wither' || type === 'magic' || type === 'sonic_boom' || type === 'starve' || type === 'void',
    fire: type === 'fire' || type === 'lava' || type === 'on_fire' || type === 'fireball',
    magic: type === 'magic' || type === 'wither' || type === 'indirect_magic',
    projectile: type === 'arrow' || type === 'fireball' || type === 'trident' || type === 'thrown',
  };
}

/** Explodes through combat.js, with a damage-only fallback. */
function explodeAt(world, x, y, z, power, opts) {
  const c = MOD.combat;
  if (c && typeof c.explode === 'function') {
    try { c.explode(world, x, y, z, power, opts || { fire: false, breakBlocks: true }); return; } catch { /* fall through */ }
  }
  const r = power * 2;
  const list = (world && world.entitiesNear) ? world.entitiesNear(x, y, z, r) : [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const dx = e.x - x, dy = (e.y + (e.height || 1) * 0.5) - y, dz = e.z - z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > r || d <= 0) continue;
    const f = 1 - d / r;
    try { e.hurt?.(Math.floor((f * f + f) * 3.5 * power) + 1, srcOf('explosion', null)); } catch { /* optional */ }
    // knockback() moves the victim along -(dx, dz), and dx/dz here point from
    // the blast centre to the victim, so pass them negated: an explosion has to
    // push outward, not suck everything in.
    try { e.knockback?.(-dx, -dz, f * 1.4); } catch { /* optional */ }
  }
  particles('explosion', x, y, z, { count: 1, size: power });
  playAt(world, 'explode', x, y, z, 4, 0.9);
}

/** Fires a projectile through projectiles.js. Returns the entity or null. */
function shootProjectile(type, world, shooter, x, y, z, dx, dy, dz, opts) {
  const p = MOD.projectiles;
  if (!p || typeof p.spawnProjectile !== 'function') return null;
  try { return p.spawnProjectile(type, world, shooter, x, y, z, dx, dy, dz, opts || {}); } catch { return null; }
}

/** Drops one item stack into the world. */
function dropStack(world, x, y, z, stack, vx = 0, vy = 0.2, vz = 0) {
  if (!stack || !stack.item || stack.count <= 0) return null;
  const it = MOD.itementity;
  if (!it || typeof it.dropItem !== 'function') return null;
  try { return it.dropItem(world, x, y, z, stack, vx, vy, vz); } catch { return null; }
}

/** Drops experience orbs. */
function dropXp(world, x, y, z, amount) {
  if (!(amount > 0)) return;
  const it = MOD.itementity;
  if (!it || typeof it.dropXP !== 'function') return;
  try { it.dropXP(world, x, y, z, amount | 0); } catch { /* optional */ }
}

/** True when mobs are allowed to change blocks in this world. */
function griefingAllowed(world) {
  return !world || !world.gameRules || world.gameRules.mobGriefing !== false;
}

/** 0..1 multiplier applied to mob attack damage for the active difficulty. */
function difficultyDamage() {
  switch (Game.difficulty) {
    case DIFFICULTY.PEACEFUL: return 0;
    case DIFFICULTY.EASY: return 0.67;
    case DIFFICULTY.HARD: return 1.5;
    default: return 1;
  }
}

/** True when the given entity is a player in a mode mobs care about. */
function isTargetablePlayer(e) {
  if (!e || e.type !== 'player' || e.removed || e.dead) return false;
  const mode = e.gameMode || Game.mode;
  return mode !== 'creative' && mode !== 'spectator';
}

const NOOP = () => {};
const NOOP_FALSE = () => false;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** name -> mob definition. */
export const MOBS = {};
/** Registration order, useful for menus and the /summon command. */
export const MOB_NAMES = [];

const DEFAULT_SPAWN = {
  dimension: DIM_OVERWORLD, biomes: null, light: null, y: null,
  group: [1, 4], weight: 10, surface: true, block: null, maxLocal: 8,
};

/**
 * Registers one mob. Every optional field is filled in so consumers can read
 * `def.<anything>` without guarding. Returns the finished definition.
 * @param {string} name canonical snake_case registry name
 * @param {object} def partial definition, see CONTRACT section 22
 */
export function defineMob(name, def = {}) {
  const height = def.height ?? 1.8;
  const category = def.category ?? 'passive';
  const hostile = category === 'hostile' || category === 'boss';
  const spawn = def.spawn || {};
  const d = {
    name,
    display: def.display ?? prettyName(name),
    category,
    // --- size ---
    width: def.width ?? 0.6,
    height,
    eyeHeight: def.eyeHeight ?? height * 0.85,
    scale: def.scale ?? 1,
    // --- attributes ---
    health: def.health ?? 10,
    armor: def.armor ?? 0,
    armorToughness: def.armorToughness ?? 0,
    damage: def.damage ?? 0,
    attackSpeed: def.attackSpeed ?? 1,
    attackReach: def.attackReach ?? 0,
    speed: def.speed ?? 0.25,
    followRange: def.followRange ?? (hostile ? 16 : 10),
    knockbackResist: def.knockbackResist ?? 0,
    xp: def.xp ?? 0,
    // --- rendering ---
    model: def.model ?? name,
    skin: def.skin ?? name,
    // --- flags ---
    fireImmune: !!def.fireImmune,
    canSwim: def.canSwim ?? true,
    flying: !!def.flying,
    waterMob: !!def.waterMob,
    amphibious: !!def.amphibious,
    burnsInDay: !!def.burnsInDay,
    avoidsSun: !!def.avoidsSun,
    undead: !!def.undead,
    arthropod: !!def.arthropod,
    illager: !!def.illager,
    aquaticBreather: !!def.aquaticBreather,
    noGravity: !!def.noGravity,
    noAI: !!def.noAI,
    immuneToFall: !!def.immuneToFall,
    pushable: def.pushable ?? true,
    // --- husbandry ---
    babyForm: !!def.babyForm,
    breedItems: def.breedItems ?? null,
    tameItems: def.tameItems ?? null,
    tempts: def.tempts ?? def.breedItems ?? null,
    tameChance: def.tameChance ?? 0.33,
    rideable: !!def.rideable,
    saddleable: !!def.saddleable,
    shearable: !!def.shearable,
    milkable: !!def.milkable,
    dyeable: !!def.dyeable,
    chestable: !!def.chestable,
    growTicks: def.growTicks ?? 24000,
    variants: def.variants ?? null,
    // --- goal wiring, read by entity/ai.js ---
    ai: def.ai ?? ['float', 'wander', 'look_at_player', 'look_random'],
    targets: def.targets ?? (hostile ? ['player'] : null),
    avoids: def.avoids ?? null,
    // --- loot ---
    drops: def.drops ?? [],
    rareDrops: def.rareDrops ?? [],
    equipment: def.equipment ?? null,
    // --- audio ---
    sounds: Object.assign({
      idle: `${name}_idle`, hurt: `${name}_hurt`, death: `${name}_death`, step: 'step',
    }, def.sounds || {}),
    // --- spawning ---
    spawn: {
      dimension: spawn.dimension ?? DEFAULT_SPAWN.dimension,
      biomes: spawn.biomes ?? null,
      light: spawn.light ?? (hostile ? [0, 7] : [8, MAX_LIGHT]),
      y: spawn.y ?? [0, WORLD_HEIGHT - 1],
      group: spawn.group ?? (hostile ? [1, 4] : [2, 4]),
      weight: spawn.weight ?? (hostile ? 100 : 10),
      surface: spawn.surface ?? true,
      block: spawn.block ?? null,
      maxLocal: spawn.maxLocal ?? DEFAULT_SPAWN.maxLocal,
      natural: spawn.natural ?? true,
    },
    // --- boss ---
    boss: !!def.boss,
    bossName: def.bossName ?? (def.boss ? (def.display ?? prettyName(name)) : null),
    bossColor: def.bossColor ?? 0xff00ff,
    // --- hooks ---
    onSpawn: def.onSpawn || NOOP,
    onTick: def.onTick || NOOP,
    onAttack: def.onAttack || NOOP,
    onHurt: def.onHurt || NOOP_FALSE,
    onDeath: def.onDeath || NOOP,
    onInteract: def.onInteract || NOOP_FALSE,
    onGrowUp: def.onGrowUp || NOOP,
    onBreed: def.onBreed || NOOP,
    ranged: def.ranged || null,
    // anything else the author added stays reachable
  };
  for (const k in def) if (!(k in d)) d[k] = def[k];
  MOBS[name] = d;
  if (MOB_NAMES.indexOf(name) < 0) MOB_NAMES.push(name);
  return d;
}

/** Definition lookup. Returns undefined for unknown names. */
export function getMob(name) { return MOBS[name]; }

/** True when a mob with this registry name exists. */
export function mobExists(name) { return Object.prototype.hasOwnProperty.call(MOBS, name); }

// ===========================================================================
// The Mob class
// ===========================================================================

const ARMOR_MATS = [
  ['leather', 1], ['golden', 2], ['chainmail', 3], ['iron', 4], ['diamond', 5],
];
const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
const ARMOR_SLOT_OF = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' };
const ARMOR_POINTS = {
  leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3],
};

/**
 * A living creature driven by a definition from MOBS and a goal-based
 * AIController. Everything shared between mobs lives here; anything specific
 * to one species lives in that species' hooks.
 */
export class Mob extends LivingEntity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {object} def a definition from MOBS
   * @param {object} [opts] spawn options: baby, variant, persistent, tamed, owner, ...
   */
  constructor(world, x, y, z, def, opts = {}) {
    super(world, x, y, z);
    const o = opts || {};
    this.def = def;
    this.type = def.name;
    this.mobName = def.name;
    this.category = def.category;
    this.isMob = true;
    this.rng = new RNG(((Math.random() * 0x7fffffff) | 0) ^ ((this.id | 0) * 2654435761));

    // --- appearance ------------------------------------------------------
    this.modelName = def.model;
    this.skinName = o.skin || def.skin;
    this.variant = o.variant ?? null;
    this.customName = o.customName ?? null;
    this.customNameVisible = false;

    // --- attributes ------------------------------------------------------
    this.baby = !!o.baby && def.babyForm;
    this.isBabyForm = this.baby;
    this.growTicks = this.baby ? (o.growTicks ?? def.growTicks) : 0;
    this.maxHealth = o.maxHealth ?? def.health;
    this.health = o.health ?? this.maxHealth;
    this.armor = def.armor;
    this.armorToughness = def.armorToughness;
    this.attackDamage = def.damage;
    this.moveSpeed = def.speed;
    this.followRange = def.followRange;
    this.knockbackResist = def.knockbackResist;
    this.xpReward = def.xp;
    this.fireImmune = def.fireImmune;
    this.undead = def.undead;
    this.arthropod = def.arthropod;
    this.canSwim = def.canSwim;
    this.waterMob = def.waterMob;
    this.flyingMob = def.flying;
    this.pushable = def.pushable;
    if (def.flying || def.noGravity) this.gravity = false;
    if (def.waterMob) this.airSupply = 300;

    // --- state -----------------------------------------------------------
    this.target = null;
    this.lastHurtBy = null;
    this.lastHurtByTicks = 0;
    this.attackCooldown = 0;
    this.swinging = false;
    this.swingTicks = 0;
    this.swingProgress = 0;
    this.jumpCooldown = 0;
    this.persistent = !!o.persistent;
    this.fromSpawner = !!o.fromSpawner;
    this.noDespawnTicks = 0;
    this.leashedTo = o.leashedTo ?? null;
    this.riding = null;
    this.passengers = [];
    this.angerTicks = 0;
    this.angry = false;
    this.panicTicks = 0;
    this.spawnBiome = null;

    // --- husbandry -------------------------------------------------------
    this.tamed = !!o.tamed;
    this.owner = o.owner ?? null;
    this.ownerName = o.ownerName ?? null;
    this.sitting = false;
    this.collarColor = o.collarColor ?? 0xe93636;
    this.loveTicks = 0;
    this.breedCooldown = 0;
    this.sheared = false;
    this.saddled = !!o.saddled;
    this.chested = false;
    this.horseArmor = null;
    this.eatTicks = 0;

    // --- equipment -------------------------------------------------------
    this.equipment = { mainhand: null, offhand: null, head: null, chest: null, legs: null, feet: null };
    this.dropChances = { mainhand: 0.085, offhand: 0.085, head: 0.085, chest: 0.085, legs: 0.085, feet: 0.085 };
    this.canPickUpLoot = false;

    this._lootDropped = false;
    this._deathSeen = false;
    this._brain = Object.create(null);   // scratch space for per-species hooks

    this.applySize();
    this.setupAI();
    try { this.spawnBiome = world && world.biomeAt ? world.biomeAt(x, z)?.name ?? null : null; } catch { this.spawnBiome = null; }
    if (def.equipment) this.rollEquipment();
    try { def.onSpawn(this, o); } catch (e) { console.error('[mob] onSpawn', def.name, e); }
  }

  /** Recomputes width/height/eyeHeight from the definition and baby flag. */
  applySize() {
    const d = this.def;
    const f = (this.baby ? 0.5 : 1) * (this.sizeScale || 1);
    this.width = d.width * f;
    this.height = d.height * f;
    this.eyeHeight = d.eyeHeight * f;
    this.renderScale = d.scale * f;
    this.stepHeight = Math.max(0.6, this.height >= 1.9 ? 1.0 : 0.6);
  }

  /** Builds the AIController from the definition's goal list. */
  setupAI() {
    this.ai = null;
    if (this.def.noAI) return;
    try {
      this.ai = new AIController(this, this.def.ai.slice());
    } catch (e) {
      console.error('[mob] could not build AI for ' + this.def.name, e);
      this.ai = null;
    }
  }

  // ---- equipment --------------------------------------------------------

  /**
   * Rolls spawn equipment. Vanilla ties the chance to local difficulty; here it
   * is a flat per-difficulty chance with a descending tier ladder, so hard-mode
   * skeletons and zombies show up armoured but easy-mode ones never do.
   */
  rollEquipment() {
    const diff = Game.difficulty;
    if (diff === DIFFICULTY.PEACEFUL) return;
    const rng = this.rng;
    const spec = this.def.equipment;
    if (Array.isArray(spec)) {
      for (let i = 0; i < spec.length; i++) {
        const e = spec[i];
        if (!e || !e.item) continue;
        if (e.chance !== undefined && !rng.chance(e.chance)) continue;
        this.setEquipment(e.slot || 'mainhand', mkStack(e.item, 1));
        if (e.dropChance !== undefined) this.dropChances[e.slot || 'mainhand'] = e.dropChance;
      }
      if (!this.def.armorRoll) return;
    }
    const armorChance = diff === DIFFICULTY.HARD ? 0.15 : diff === DIFFICULTY.NORMAL ? 0.05 : 0;
    if (armorChance <= 0 || !rng.chance(armorChance)) return;
    // One material for the whole set, then a decreasing chance for each lower
    // piece - exactly the shape of vanilla's armour ladder.
    let mat = ARMOR_MATS[Math.min(ARMOR_MATS.length - 1, rng.range(0, diff === DIFFICULTY.HARD ? 4 : 2))][0];
    let chance = 1;
    for (let i = 0; i < ARMOR_PIECES.length; i++) {
      if (!rng.chance(chance)) break;
      const item = `${mat}_${ARMOR_PIECES[i]}`;
      if (itemExists(item)) this.setEquipment(ARMOR_SLOT_OF[ARMOR_PIECES[i]], mkStack(item, 1));
      chance *= 0.65;
    }
  }

  /** Puts a stack in one of the six equipment slots. */
  setEquipment(slot, stack) {
    if (!(slot in this.equipment)) return;
    this.equipment[slot] = stack;
    if (slot === 'mainhand') this.heldItem = stack ? stack.item : null;
  }

  /** The stack in the main hand, or null. */
  getHeldItem() { return this.equipment.mainhand; }

  /** Armour points from the definition plus any worn pieces. */
  getArmorPoints() {
    let pts = this.armor;
    const slots = ['head', 'chest', 'legs', 'feet'];
    for (let i = 0; i < slots.length; i++) {
      const s = this.equipment[slots[i]];
      if (!s || !s.item) continue;
      const cut = s.item.indexOf('_');
      const mat = cut > 0 ? s.item.slice(0, cut) : '';
      const table = ARMOR_POINTS[mat];
      if (table) pts += table[i];
      else if (s.item.indexOf('netherite') === 0) pts += [3, 8, 6, 3][i];
      else if (s.item === 'turtle_helmet') pts += 2;
    }
    return pts;
  }

  /** True when something is worn on the head (blocks sun burning). */
  hasHelmet() {
    const h = this.equipment.head;
    return !!(h && h.item);
  }

  // ---- targeting helpers -------------------------------------------------

  /** Sets the attack target on both the mob and its controller. */
  setTarget(e) {
    this.target = e || null;
    if (this.ai) this.ai.target = this.target;
  }

  /** Nearest valid player inside `range`, or null. */
  nearestPlayer(range = this.followRange) {
    const w = this.world;
    if (!w) return null;
    let best = null, bestD = range * range;
    const players = w.getPlayers ? w.getPlayers() : (w.entities || []).filter((e) => e.type === 'player');
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!isTargetablePlayer(p)) continue;
      const dx = p.x - this.x, dy = p.y - this.y, dz = p.z - this.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** Line-of-sight test from this mob's eyes to another entity's eyes. */
  canSee(e) {
    if (!e || !this.world || !this.world.raycast) return !!e;
    const ex = this.x, ey = this.y + this.eyeHeight, ez = this.z;
    const tx = e.x, ty = e.y + (e.eyeHeight || (e.height || 1) * 0.8), tz = e.z;
    let dx = tx - ex, dy = ty - ey, dz = tz - ez;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.01) return true;
    if (dist > 128) return false;
    dx /= dist; dy /= dist; dz /= dist;
    const hit = this.world.raycast(ex, ey, ez, dx, dy, dz, dist, { fluids: false });
    return !hit || hit.distance >= dist - 0.15;
  }

  /** Turns the head (and body) toward an entity. */
  faceEntity(e, speed = 0.4) {
    if (!e) return;
    this.lookAtPoint(e.x, e.y + (e.eyeHeight || (e.height || 1) * 0.8), e.z, speed);
  }

  /** Turns toward a point, easing yaw/pitch so mobs do not snap. */
  lookAtPoint(x, y, z, speed = 0.4) {
    const dx = x - this.x, dy = y - (this.y + this.eyeHeight), dz = z - this.z;
    const yaw = Math.atan2(-dx, dz);
    const pitch = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    this.headYaw = this.headYaw + angleDiff(this.headYaw ?? this.yaw, yaw) * speed;
    this.yaw = this.yaw + angleDiff(this.yaw, yaw) * speed * 0.6;
    this.pitch = this.pitch + (pitch - this.pitch) * speed;
    this.headPitch = this.pitch;
  }

  /** Asks the controller to path somewhere; steers directly when it cannot. */
  moveTo(x, y, z, speed = 1) {
    if (this.ai && typeof this.ai.moveTo === 'function') {
      try { this.ai.moveTo(x, y, z, speed); return; } catch { /* fall through */ }
    }
    const dx = x - this.x, dz = z - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    const s = this.moveSpeed * speed * 4.3;
    this.vx += (dx / d) * s * 0.05;
    this.vz += (dz / d) * s * 0.05;
  }

  /** A standing jump, respecting the jump cooldown. */
  jump() {
    if (!this.onGround || this.jumpCooldown > 0) return false;
    this.vy = 8.4 * (this.baby ? 0.8 : 1);
    this.jumpCooldown = 10;
    return true;
  }

  /** True when standing in full daylight under an open sky. */
  isInDaylight() {
    const w = this.world;
    if (!w || w.dimension !== DIM_OVERWORLD) return false;
    if (!w.isDay || !w.isDay()) return false;
    if (w.skyLightFactor && w.skyLightFactor() < 0.5) return false;
    const y = Math.floor(this.y + this.height * 0.9);
    if (!w.canSeeSky || !w.canSeeSky(Math.floor(this.x), y, Math.floor(this.z))) return false;
    return true;
  }

  // ---- combat ------------------------------------------------------------

  /** Damage this mob deals right now, after difficulty and strength. */
  getAttackDamage() {
    let dmg = this.attackDamage * difficultyDamage();
    if (this.baby && !this.def.babyFullDamage) dmg *= 0.6;
    const held = this.equipment.mainhand;
    if (held && held.item) {
      const w = WEAPON_DAMAGE[held.item];
      if (w) dmg += w;
    }
    if (this.hasEffect && this.hasEffect('strength')) {
      const lv = (this.getEffect('strength')?.level ?? 0) + 1;
      dmg += 3 * lv;
    }
    if (this.hasEffect && this.hasEffect('weakness')) {
      const lv = (this.getEffect('weakness')?.level ?? 0) + 1;
      dmg = Math.max(0, dmg - 4 * lv);
    }
    return dmg;
  }

  /** Melee swing at a target. Returns true when damage landed. */
  attack(target) {
    if (!target || target.removed || (target.isAlive && !target.isAlive())) return false;
    this.swinging = true;
    this.swingTicks = 0;
    this.attackCooldown = Math.max(4, Math.round(20 / (this.def.attackSpeed || 1)));
    const dmg = this.getAttackDamage();
    if (dmg <= 0) return false;
    // Entity.hurt already knocks the victim back, away from source.entity, and
    // sets source.knockedBack so nothing stacks a second shove. Pass the mob's
    // strength through the source instead of applying our own: the manual call
    // that used to live here passed (target - attacker), the reverse vector, so
    // its shove pointed INTO the mob and overpowered the correct one - being
    // hit pulled you towards the attacker instead of away from it.
    const src = srcOf('mob', this, this);
    src.knockback = 0.4 + (this.def.knockback || 0) * 0.5;
    const applied = target.hurt ? target.hurt(dmg, src) : false;
    if (applied) {
      const held = this.equipment.mainhand;
      if (held && held.fireAspect) target.fireTicks = Math.max(target.fireTicks || 0, 80);
      if (this.fireTicks > 0 && !this.def.fireImmune) target.fireTicks = Math.max(target.fireTicks || 0, 40);
      try { this.def.onAttack(this, target); } catch (e) { console.error('[mob] onAttack', this.type, e); }
      playAt(this.world, this.def.sounds.attack || 'mob_attack', this.x, this.y, this.z, 1, 1);
    }
    return applied;
  }

  /** Ranged attack entry point used by the attack_bow / attack_ranged goals. */
  rangedAttack(target, power = 1) {
    if (!target || !this.def.ranged) return false;
    try { this.def.ranged(this, target, power); } catch (e) { console.error('[mob] ranged', this.type, e); }
    return true;
  }

  /** Alias so different goal implementations find the same entry point. */
  attackRanged(target, power = 1) { return this.rangedAttack(target, power); }

  /** Alias used by ranged_fireball style goals. */
  performRangedAttack(target, power = 1) { return this.rangedAttack(target, power); }

  /**
   * Damage handler. Runs the definition's onHurt hook first (so endermen can
   * teleport out of the way and wardens can shrug off arrows), then defers to
   * LivingEntity for the actual bookkeeping.
   */
  hurt(amount, source) {
    if (this.removed || this.invulnerable) return false;
    if (this.def.fireImmune && source && source.fire) return false;
    if (this.teleporting) return false;
    let amt = amount;
    try {
      const r = this.def.onHurt(this, amt, source);
      if (r === false) return false;
      if (typeof r === 'number') amt = r;
    } catch (e) { console.error('[mob] onHurt', this.type, e); }
    const before = this.health;
    const applied = super.hurt(amt, source);
    if (applied) {
      const attacker = source && (source.entity || source.direct);
      if (attacker && attacker !== this) {
        this.lastHurtBy = attacker;
        this.lastHurtByTicks = 100;
        if (this.shouldRetaliate(attacker)) this.setTarget(attacker);
      }
      this.panicTicks = this.def.category === 'passive' ? 100 : this.panicTicks;
      if (this.sitting && this.def.tameItems) this.sitting = false;
      playAt(this.world, this.def.sounds.hurt, this.x, this.y, this.z, 1, 1 + (this.rng.next() - 0.5) * 0.2);
      if (this.health <= 0 && before > 0) this.handleDeath(source);
    }
    return applied;
  }

  /** Whether being hit by `attacker` should make this mob fight back. */
  shouldRetaliate(attacker) {
    const c = this.def.category;
    if (c === 'passive' || c === 'ambient' || this.def.noAI) return false;
    if (this.tamed && attacker === this.owner) return false;
    if (attacker && attacker.type === this.type && !this.def.friendlyFire) return false;
    return true;
  }

  /** Death bookkeeping: hooks, loot, experience. Safe to call twice. */
  handleDeath(source) {
    if (this._deathSeen) return;
    this._deathSeen = true;
    // Entity.kill() sets dead and emits 'entitydeath' itself. When the hit came
    // through hurt(), kill() has already run by the time we get here, so emit
    // only when it has not - otherwise every mob death fired the event twice.
    const alreadyEmitted = this.dead;
    this.dead = true;
    playAt(this.world, this.def.sounds.death, this.x, this.y, this.z, 1, 1);
    try { this.def.onDeath(this, source); } catch (e) { console.error('[mob] onDeath', this.type, e); }
    this.dropLoot(source, lootingOf(source));
    if (!alreadyEmitted) Game.emit('entitydeath', this, source);
  }

  /**
   * Rolls the definition's drop tables and spits out the results plus XP.
   * Guarded so LivingEntity calling it too cannot double up.
   */
  dropLoot(source = null, looting = 0) {
    if (this._lootDropped) return [];
    this._lootDropped = true;
    const w = this.world;
    if (!w) return [];
    const rng = this.rng;
    const out = [];
    const burning = this.fireTicks > 0;
    const playerKill = !!(source && source.entity && source.entity.type === 'player');
    if (!this.baby || this.def.babyDrops) {
      for (const d of this.def.drops) {
        if (!d || !d.item) continue;
        if (d.playerOnly && !playerKill) continue;
        if (d.chance !== undefined && !rng.chance(d.chance)) continue;
        let n = d.min === undefined ? 1 : rng.range(d.min, d.max ?? d.min);
        if (d.looting) n += rng.range(0, d.looting * looting);
        if (n <= 0) continue;
        let item = d.item;
        if (burning && COOKED[item]) item = COOKED[item];
        out.push(mkStack(item, n, d.extra || null));
      }
      for (const d of this.def.rareDrops) {
        if (!d || !d.item) continue;
        if (d.playerOnly && !playerKill) continue;
        const chance = (d.chance ?? 0.025) + looting * (d.lootingBonus ?? 0.01);
        if (!rng.chance(chance)) continue;
        out.push(mkStack(item0(d), d.min === undefined ? 1 : rng.range(d.min, d.max ?? d.min)));
      }
    }
    // Worn gear falls off sometimes, exactly like vanilla.
    for (const slot in this.equipment) {
      const s = this.equipment[slot];
      if (!s || !s.item) continue;
      if (rng.next() >= (this.dropChances[slot] ?? 0.085) + looting * 0.01) continue;
      out.push(mkStack(s.item, 1, { damage: s.damage || 0 }));
    }
    for (let i = 0; i < out.length; i++) {
      dropStack(w, this.x, this.y + this.height * 0.5, this.z,
        out[i], (rng.next() - 0.5) * 0.6, 0.25, (rng.next() - 0.5) * 0.6);
    }
    if (playerKill || this.fromSpawner || this.def.alwaysDropsXp) {
      const xp = this.baby && !this.def.boss ? Math.ceil(this.def.xp * 2.5) : this.def.xp;
      dropXp(w, this.x, this.y + this.height * 0.5, this.z, xp);
    }
    return out;
  }

  /**
   * @override Mob.dropLoot already spawns this mob's XP orbs, and knows the
   * baby / spawner / alwaysDropsXp rules. The LivingEntity fallback would add a
   * second identical batch, so a killed mob paid out double.
   */
  dropXP(_source) { /* handled by dropLoot */ }

  /** Alias in case the base class prefers this name. */
  dropDeathLoot(source, looting) { return this.dropLoot(source, looting); }

  // ---- interaction -------------------------------------------------------

  /**
   * Right-click handler. Runs shared husbandry first (breeding, taming,
   * sitting, name tags, saddles) and falls back to the definition hook.
   * @returns {boolean} true when the interaction consumed the click
   */
  interact(player, stack, hand = 'mainhand') {
    if (!player) return false;
    const item = stack && stack.item ? stack.item : null;
    const d = this.def;

    // Custom hook wins, so species can override the generic paths.
    let handled = false;
    try { handled = !!d.onInteract(this, player, stack, hand); } catch (e) { console.error('[mob] onInteract', this.type, e); }
    if (handled) return true;

    if (item === 'name_tag' && stack.customName) {
      this.customName = stack.customName;
      this.persistent = true;
      shrinkHeld(player, stack);
      return true;
    }
    if (item === 'lead' && !this.def.boss) {
      this.leashedTo = this.leashedTo === player ? null : player;
      return true;
    }
    // Taming.
    if (!this.tamed && d.tameItems && item && d.tameItems.indexOf(item) >= 0) {
      shrinkHeld(player, stack);
      if (this.rng.chance(d.tameChance)) this.tame(player);
      else particles('smoke', this.x, this.y + this.height, this.z, { count: 7, spread: 0.4 });
      return true;
    }
    // Growth acceleration + breeding.
    if (item && d.breedItems && d.breedItems.indexOf(item) >= 0) {
      if (this.baby) {
        this.growTicks = Math.max(0, this.growTicks - Math.floor(d.growTicks * 0.1));
        shrinkHeld(player, stack);
        particles('heart', this.x, this.y + this.height, this.z, { count: 3, spread: 0.4 });
        return true;
      }
      if (this.breedCooldown <= 0 && this.loveTicks <= 0) {
        this.loveTicks = 600;
        this.lovePartnerOwner = player;
        shrinkHeld(player, stack);
        particles('heart', this.x, this.y + this.height, this.z, { count: 7, spread: 0.5 });
        return true;
      }
    }
    // Sit / stand for tamed pets.
    if (this.tamed && this.isOwner(player) && d.tameItems) {
      this.sitting = !this.sitting;
      this.setTarget(null);
      return true;
    }
    // Saddling and riding.
    if (d.saddleable && item === 'saddle' && !this.saddled) {
      this.saddled = true;
      shrinkHeld(player, stack);
      playAt(this.world, 'saddle', this.x, this.y, this.z, 1, 1);
      return true;
    }
    if (d.rideable && this.saddled && !item) {
      this.mount(player);
      return true;
    }
    if (d.milkable && item === 'bucket') return false;    // items.js handles the bucket swap
    return false;
  }

  /** Marks this mob as tamed by `player`. */
  tame(player) {
    this.tamed = true;
    this.owner = player;
    this.ownerName = player && (player.name || 'Player');
    this.persistent = true;
    this.setTarget(null);
    this.angry = false;
    if (this.def.tamedHealth) { this.maxHealth = this.def.tamedHealth; this.health = this.maxHealth; }
    if (this.def.tamedSpeed) this.moveSpeed = this.def.tamedSpeed;
    particles('heart', this.x, this.y + this.height, this.z, { count: 7, spread: 0.5 });
    return true;
  }

  /** True when `e` is this mob's owner. */
  isOwner(e) { return !!e && this.owner === e; }

  /** Seats a rider on this mob. */
  mount(rider) {
    if (!rider || this.passengers.indexOf(rider) >= 0) return false;
    this.passengers.push(rider);
    rider.riding = this;
    rider.vehicle = this;
    return true;
  }

  /** Removes a rider. */
  dismount(rider) {
    const i = this.passengers.indexOf(rider);
    if (i < 0) return false;
    this.passengers.splice(i, 1);
    rider.riding = null;
    rider.vehicle = null;
    rider.y = this.y + this.height + 0.1;
    return true;
  }

  // ---- husbandry ---------------------------------------------------------

  /** Turns a baby into an adult, resizing and firing the hook. */
  growUp() {
    if (!this.baby) return;
    this.baby = false;
    this.isBabyForm = false;
    this.growTicks = 0;
    this.applySize();
    try { this.def.onGrowUp(this); } catch (e) { console.error('[mob] onGrowUp', this.type, e); }
  }

  /** Spawns a baby between the two parents and resets both love timers. */
  breedWith(other) {
    if (!other || other === this || other.def !== this.def) return null;
    const w = this.world;
    const baby = createMob(this.def.name, w, (this.x + other.x) / 2, this.y, (this.z + other.z) / 2, {
      baby: true, variant: this.rng.bool() ? this.variant : other.variant,
    });
    this.loveTicks = 0; other.loveTicks = 0;
    this.breedCooldown = 6000; other.breedCooldown = 6000;
    if (baby) {
      baby.parent = this;
      try { this.def.onBreed(this, other, baby); } catch (e) { console.error('[mob] onBreed', this.type, e); }
    }
    particles('heart', this.x, this.y + this.height, this.z, { count: 7, spread: 0.6 });
    dropXp(w, this.x, this.y, this.z, this.rng.range(1, 7));
    return baby;
  }

  /** Shears this mob if the definition allows it. Returns the drops. */
  shear() {
    if (!this.def.shearable || this.sheared || this.baby) return null;
    this.sheared = true;
    this.shorn = true;
    playAt(this.world, 'sheep_shear', this.x, this.y, this.z, 1, 1);
    const drops = [];
    const spec = this.def.shearDrops;
    if (spec) {
      for (const s of spec) {
        const name = typeof s.item === 'function' ? s.item(this) : s.item;
        const n = this.rng.range(s.min ?? 1, s.max ?? 1);
        drops.push(mkStack(name, n));
        dropStack(this.world, this.x, this.y + this.height * 0.6, this.z, mkStack(name, n));
      }
    }
    return drops;
  }

  /** Teleports to a spot if it is free, mimicking the enderman rules. */
  teleportTo(x, y, z) {
    const w = this.world;
    if (!w) return false;
    const fy = Math.floor(y);
    if (fy < 1 || fy > WORLD_HEIGHT - 2) return false;
    if (w.isSolid(Math.floor(x), fy, Math.floor(z)) || w.isSolid(Math.floor(x), fy + 1, Math.floor(z))) return false;
    let ground = fy;
    while (ground > 1 && !w.isSolid(Math.floor(x), ground - 1, Math.floor(z))) ground--;
    if (fy - ground > 4) return false;
    particles('portal', this.x, this.y + this.height * 0.5, this.z, { count: 24, spread: 0.7 });
    playAt(w, 'enderman_teleport', this.x, this.y, this.z, 1, 1);
    this.x = x; this.y = ground; this.z = z;
    this.px = x; this.py = ground; this.pz = z;
    this.vx = this.vy = this.vz = 0;
    this.fallDistance = 0;
    if (w.onEntityMoved) w.onEntityMoved(this);
    particles('portal', x, y + this.height * 0.5, z, { count: 24, spread: 0.7 });
    return true;
  }

  /** Random 64x64x32 teleport, used by endermen and the shulker. */
  teleportRandom(range = 32) {
    const r = this.rng;
    for (let i = 0; i < 16; i++) {
      const x = this.x + (r.next() - 0.5) * range * 2;
      const y = this.y + r.range(-8, 8);
      const z = this.z + (r.next() - 0.5) * range * 2;
      if (this.teleportTo(x, y, z)) return true;
    }
    return false;
  }

  // ---- per-tick ----------------------------------------------------------

  /**
   * The 20 Hz update. Shared upkeep runs first (timers, growth, burning,
   * water, leashes), then the AI controller, then the species hook - so a
   * hook can always override what the generic code just decided.
   */
  tick() {
    super.tick();
    if (this.removed) return;
    const w = this.world;
    if (!w) return;

    if (this.health <= 0) {
      if (!this._deathSeen) this.handleDeath(this.lastDamageSource);
      // Entity.tick already advances deathTime. Incrementing it here too ran
      // the death animation at double speed and binned the corpse in 10 ticks.
      // The removal below still matters: Entity.tick only reaps mobs that are
      // not persistent, and villagers, tamed pets, golems and bosses all are.
      if (this.deathTime > 20) this.remove();
      return;
    }

    this.tickTimers();
    this.tickGrowth();
    this.tickLove();
    this.tickBurning();
    this.tickWater();
    this.tickLeash();

    // A sitting or leashed-taut pet stops thinking about anything else.
    if (this.sitting) {
      this.setTarget(null);
      this.vx *= 0.6; this.vz *= 0.6;
    } else if (this.ai) {
      try {
        this.ai.tick();
        if (this.ai.target !== undefined) this.target = this.ai.target;
      } catch (e) {
        console.error('[mob] ai tick failed for ' + this.type, e);
        this.ai = null;
      }
    }

    // Drop a target that died, vanished or wandered out of range.
    const t = this.target;
    if (t && (t.removed || t.dead || (t.isAlive && !t.isAlive()) ||
      this.distanceToSq(t.x, t.y, t.z) > this.followRange * this.followRange * 2.25)) {
      this.setTarget(null);
    }

    try { this.def.onTick(this); } catch (e) { console.error('[mob] onTick', this.type, e); }

    if ((this.age & 31) === 0) this.despawnCheck();
    if ((this.age % 120) === 0 && this.rng.chance(0.25) && !this.def.boss) {
      playAt(w, this.def.sounds.idle, this.x, this.y, this.z, 0.7, 0.9 + this.rng.next() * 0.2);
    }
  }

  /** Counts down every per-tick timer this class owns. */
  tickTimers() {
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.jumpCooldown > 0) this.jumpCooldown--;
    if (this.lastHurtByTicks > 0 && --this.lastHurtByTicks === 0) this.lastHurtBy = null;
    if (this.panicTicks > 0) this.panicTicks--;
    if (this.breedCooldown > 0) this.breedCooldown--;
    if (this.angerTicks > 0 && --this.angerTicks === 0) { this.angry = false; this.setTarget(null); }
    if (this.noDespawnTicks < 100000) this.noDespawnTicks++;
    if (this.swinging) {
      this.swingTicks++;
      this.swingProgress = clamp(this.swingTicks / 6, 0, 1);
      if (this.swingTicks > 6) { this.swinging = false; this.swingTicks = 0; this.swingProgress = 0; }
    }
    if (this.eatTicks > 0) this.eatTicks--;
    if (this.headYaw === undefined) this.headYaw = this.yaw;
  }

  /** Baby -> adult countdown. */
  tickGrowth() {
    if (!this.baby) return;
    if (this.growTicks > 0) { this.growTicks--; return; }
    this.growUp();
  }

  /** Love mode: hearts, partner search, and the actual breeding. */
  tickLove() {
    if (this.loveTicks <= 0) return;
    this.loveTicks--;
    if ((this.age & 7) === 0) particles('heart', this.x, this.y + this.height * 0.8, this.z, { count: 1, spread: 0.3 });
    if ((this.age & 15) !== 0) return;
    const w = this.world;
    const near = w.entitiesNear(this.x, this.y, this.z, 8, (e) => e !== this && e.def === this.def && e.loveTicks > 0);
    if (!near.length) return;
    const mate = near[0];
    if (this.distanceTo(mate) > 3) { this.moveTo(mate.x, mate.y, mate.z, 1); return; }
    this.breedWith(mate);
  }

  /** Undead burn in the sun unless helmeted, in water or in the shade. */
  tickBurning() {
    if (!this.def.burnsInDay || this.fireImmune) return;
    if (this.inWater || this.submerged) return;
    if (!this.isInDaylight()) return;
    const helmet = this.equipment.head;
    if (helmet && helmet.item) {
      // The helmet takes the damage instead, and eventually breaks.
      if (this.rng.chance(0.04)) {
        helmet.damage = (helmet.damage || 0) + 1;
        if (helmet.damage > 60) this.setEquipment('head', null);
      }
      return;
    }
    this.fireTicks = Math.max(this.fireTicks || 0, 160);
  }

  /** Buoyancy for land mobs, suffocation for fish, lava striding. */
  tickWater() {
    const d = this.def;
    if (d.waterMob) {
      if (!this.inWater && !d.amphibious) {
        this.airSupply = (this.airSupply ?? 300) - 1;
        if (this.airSupply <= -20) { this.airSupply = 0; this.hurt(1, srcOf('drown')); }
        // Flop about on land.
        if (this.onGround && this.rng.chance(0.3)) {
          this.vy = 4.2; this.vx = (this.rng.next() - 0.5) * 2; this.vz = (this.rng.next() - 0.5) * 2;
        }
      } else {
        this.airSupply = 300;
      }
      return;
    }
    if (this.inWater && this.canSwim) {
      // Float: mobs bob at the surface instead of sinking like a stone.
      this.vy = Math.min(this.vy + 12 * 0.05, 3.2);
      this.fallDistance = 0;
    }
    if (this.inLava && !this.fireImmune) this.fireTicks = Math.max(this.fireTicks || 0, 300);
  }

  /** Leash physics: pull toward the holder, snap when stretched too far. */
  tickLeash() {
    const h = this.leashedTo;
    if (!h || h.removed) { if (h) this.leashedTo = null; return; }
    const dx = h.x - this.x, dy = h.y - this.y, dz = h.z - this.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 10) {
      this.leashedTo = null;
      dropStack(this.world, this.x, this.y + 0.5, this.z, mkStack('lead', 1));
      return;
    }
    if (d < 5) return;
    const f = (d - 4) * 0.6;
    this.vx += (dx / d) * f;
    this.vz += (dz / d) * f;
    if (dy > 1.5 && this.onGround) this.jump();
  }

  /** Vanilla-shaped despawn rules: instant far away, random when merely far. */
  despawnCheck() {
    const d = this.def;
    if (this.persistent || this.customName || this.tamed || d.boss || d.category === 'boss') return;
    if (d.category === 'passive' && this.leashedTo) return;
    const p = this.nearestPlayer(Infinity);
    if (!p) return;
    const dx = p.x - this.x, dy = p.y - this.y, dz = p.z - this.z;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd > 128 * 128) { this.remove(); return; }
    if (dd > 32 * 32 && this.noDespawnTicks > 600 && this.rng.chance(1 / 800)) this.remove();
  }

  // ---- persistence -------------------------------------------------------

  /** Adds the mob-specific fields to whatever LivingEntity already saves. */
  serialize() {
    const base = (super.serialize && super.serialize()) || {};
    base.type = this.type;
    base.mob = this.type;
    base.baby = this.baby;
    base.growTicks = this.growTicks;
    base.variant = this.variant;
    base.customName = this.customName;
    base.persistent = this.persistent;
    base.tamed = this.tamed;
    base.ownerName = this.ownerName;
    base.sitting = this.sitting;
    base.collarColor = this.collarColor;
    base.sheared = this.sheared;
    base.saddled = this.saddled;
    base.chested = this.chested;
    base.horseArmor = this.horseArmor;
    base.loveTicks = this.loveTicks;
    base.breedCooldown = this.breedCooldown;
    base.angerTicks = this.angerTicks;
    base.equipment = this.equipment;
    base.woolColor = this.woolColor;
    base.charged = this.charged;
    base.slimeSize = this.slimeSize;
    base.health = this.health;
    base.maxHealth = this.maxHealth;
    if (this.def.serializeExtra) {
      try { this.def.serializeExtra(this, base); } catch { /* optional */ }
    }
    return base;
  }

  /** Rebuilds a mob from serialize() output. */
  static deserialize(obj, world) {
    if (!obj) return null;
    const name = obj.mob || obj.type;
    const m = createMob(name, world, obj.x ?? 0, obj.y ?? 0, obj.z ?? 0, {
      baby: !!obj.baby, variant: obj.variant ?? null, persistent: obj.persistent !== false,
      addToWorld: false,
    });
    if (!m) return null;
    for (const k of ['growTicks', 'customName', 'tamed', 'ownerName', 'sitting', 'collarColor',
      'sheared', 'saddled', 'chested', 'horseArmor', 'loveTicks', 'breedCooldown', 'angerTicks',
      'woolColor', 'charged', 'slimeSize', 'maxHealth', 'health', 'yaw', 'pitch', 'vx', 'vy', 'vz']) {
      if (obj[k] !== undefined) m[k] = obj[k];
    }
    if (obj.equipment) Object.assign(m.equipment, obj.equipment);
    m.applySize();
    if (m.def.deserializeExtra) {
      try { m.def.deserializeExtra(m, obj); } catch { /* optional */ }
    }
    return m;
  }

  /** Blows this mob up (creeper, charged creeper). */
  explodeSelf(power) {
    const w = this.world;
    this.dropLoot(srcOf('explosion', this), 0);
    this._deathSeen = true;
    explodeAt(w, this.x, this.y + this.height * 0.5, this.z, power,
      { fire: false, breakBlocks: griefingAllowed(w), source: this });
    this.remove();
  }
}

// Weapon bonus for spawn-equipped mobs. Kept tiny on purpose - only the
// weapons a mob can actually roll matter here.
const WEAPON_DAMAGE = {
  wooden_sword: 4, stone_sword: 5, golden_sword: 4, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 7, stone_axe: 9, golden_axe: 7, iron_axe: 9, diamond_axe: 9, netherite_axe: 10,
  wooden_shovel: 2.5, stone_shovel: 3.5, iron_shovel: 4.5, trident: 9,
};

// Raw -> cooked, used when a burning animal dies.
const COOKED = {
  porkchop: 'cooked_porkchop', beef: 'cooked_beef', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon',
};

/** Item name of a rare-drop entry (they may be plain strings). */
function item0(d) { return typeof d === 'string' ? d : d.item; }

/** Looting level of whatever killed the mob. */
function lootingOf(source) {
  const e = source && (source.entity || source.direct);
  const held = e && e.getHeldItem ? e.getHeldItem() : null;
  const ench = held && held.enchantments;
  if (!ench) return 0;
  return ench.looting || 0;
}

/** Consumes one item from the player's hand unless they are in creative. */
function shrinkHeld(player, stack) {
  if (!stack) return;
  const mode = player.gameMode || Game.mode;
  if (mode === 'creative') return;
  stack.count -= 1;
  if (stack.count <= 0 && player.inventory && player.selectedSlot !== undefined) {
    try { player.inventory.set(player.selectedSlot, null); } catch { /* optional */ }
  }
}

// ===========================================================================
// Shared pieces for the definitions below
// ===========================================================================

/** A normal drop entry. */
const D = (item, min = 1, max = min, looting = 0) => ({ item, min, max, looting });
/** A rare drop entry (chance-gated, often player-kill only). */
const RD = (item, chance = 0.025, min = 1, max = 1) => ({ item, chance, min, max, lootingBonus: 0.01 });

const AI_PASSIVE = ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'];
const AI_NEUTRAL = ['float', 'hurt_by_target', 'attack_melee', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'];
const AI_HOSTILE = ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'wander', 'look_at_player', 'look_random'];
const AI_UNDEAD = ['float', 'restrict_sun', 'flee_sun', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'wander', 'look_at_player', 'look_random'];
const AI_BOW = ['float', 'restrict_sun', 'flee_sun', 'hurt_by_target', 'nearest_attackable_target', 'attack_bow', 'wander', 'look_at_player', 'look_random'];
const AI_WATER = ['swim_wander', 'look_at_player', 'look_random'];
const AI_PET = ['float', 'sit', 'follow_owner', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'panic', 'tempt', 'breed', 'wander', 'look_at_player', 'look_random'];

/** First matching block position inside a cube, or null. Used for scent-like searches. */
function findBlockNear(world, ox, oy, oz, r, ids) {
  if (!world) return null;
  const cx = Math.floor(ox), cy = Math.floor(oy), cz = Math.floor(oz);
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= WORLD_HEIGHT) continue;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const id = world.getBlock(cx + dx, y, cz + dz);
        if (id && ids.indexOf(id) >= 0) return { x: cx + dx, y, z: cz + dz };
      }
    }
  }
  return null;
}

/** Entities near a mob matching a predicate. */
function near(mob, r, filter) {
  const w = mob.world;
  if (!w || !w.entitiesNear) return [];
  return w.entitiesNear(mob.x, mob.y, mob.z, r, filter);
}

/** Aims at a target with a little lead so ranged mobs are not trivially dodged. */
function aimAt(mob, target, projectileSpeed = 1.6, arc = 0.12) {
  const ey = mob.y + mob.eyeHeight;
  const dx0 = target.x - mob.x, dz0 = target.z - mob.z;
  const flat = Math.sqrt(dx0 * dx0 + dz0 * dz0);
  const lead = flat / Math.max(0.001, projectileSpeed * 20);
  const px = target.x + (target.vx || 0) * lead;
  const pz = target.z + (target.vz || 0) * lead;
  const py = target.y + (target.height || 1.8) * 0.5 + (target.vy || 0) * lead * 0.4;
  let dx = px - mob.x, dy = py - ey, dz = pz - mob.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  dy += d * arc;                                  // compensate for gravity drop
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  return { dx: dx / len, dy: dy / len, dz: dz / len, dist: d };
}

/** Standard bow shot with per-difficulty inaccuracy. */
function bowShot(mob, target, opts) {
  const a = aimAt(mob, target, 1.6, 0.11);
  const spread = Game.difficulty === DIFFICULTY.HARD ? 0.02 : Game.difficulty === DIFFICULTY.EASY ? 0.09 : 0.05;
  const r = mob.rng;
  const dx = a.dx + (r.next() - 0.5) * spread;
  const dy = a.dy + (r.next() - 0.5) * spread;
  const dz = a.dz + (r.next() - 0.5) * spread;
  shootProjectile(opts?.type || 'arrow', mob.world, mob,
    mob.x, mob.y + mob.eyeHeight - 0.1, mob.z, dx, dy, dz,
    Object.assign({ power: 1, damage: 2, speed: 1.6 }, opts || {}));
  playAt(mob.world, 'bow', mob.x, mob.y, mob.z, 1, 1 / (r.next() * 0.4 + 0.8));
  mob.swinging = true; mob.swingTicks = 0;
}

/** Bow cooldown in ticks: 20 on hard, 40 otherwise (vanilla). */
function bowCooldown() { return Game.difficulty === DIFFICULTY.HARD ? 20 : 40; }

// Vanilla natural sheep colours: mostly white with a long tail of rare coats.
const SHEEP_WEIGHTS = [['white', 8184], ['black', 500], ['gray', 500], ['light_gray', 500],
  ['brown', 300], ['pink', 16]];

/** Weighted pick from [value, weight] pairs. */
function weightedPick(rng, pairs) {
  let total = 0;
  for (const p of pairs) total += p[1];
  let r = rng.next() * total;
  for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
  return pairs[pairs.length - 1][0];
}

// ===========================================================================
// Passive and neutral mobs
// ===========================================================================

defineMob('pig', {
  category: 'passive', width: 0.9, height: 0.9, eyeHeight: 0.76,
  health: 10, speed: 0.25, xp: 1, model: 'pig', skin: 'pig',
  babyForm: true, breedItems: ['carrot', 'potato', 'beetroot'],
  tempts: ['carrot', 'potato', 'beetroot', 'carrot_on_a_stick'],
  saddleable: true, rideable: true,
  drops: [D('porkchop', 1, 3, 1)],
  ai: AI_PASSIVE,
  spawn: { light: [9, 15], group: [3, 4], weight: 10, block: 'grass_block' },
  onTick(m) {
    // A saddled pig follows a carrot on a stick held by its rider.
    const rider = m.passengers[0];
    if (!rider || !m.saddled) return;
    const held = rider.getHeldItem ? rider.getHeldItem() : null;
    if (held && held.item === 'carrot_on_a_stick') {
      const yaw = rider.yaw;
      m.yaw = yaw;
      m.vx += -Math.sin(yaw) * 0.32;
      m.vz += Math.cos(yaw) * 0.32;
    }
  },
});

defineMob('cow', {
  category: 'passive', width: 0.9, height: 1.4, eyeHeight: 1.3,
  health: 10, speed: 0.2, xp: 1,
  babyForm: true, breedItems: ['wheat'], milkable: true,
  drops: [D('leather', 0, 2, 1), D('beef', 1, 3, 1)],
  ai: AI_PASSIVE,
  spawn: { light: [9, 15], group: [4, 4], weight: 8, block: 'grass_block' },
});

defineMob('mooshroom', {
  category: 'passive', width: 0.9, height: 1.4, eyeHeight: 1.3,
  health: 10, speed: 0.2, xp: 1, model: 'mooshroom', skin: 'mooshroom',
  babyForm: true, breedItems: ['wheat'], milkable: true, shearable: true,
  variants: ['red', 'brown'],
  shearDrops: [{ item: (m) => (m.variant === 'brown' ? 'brown_mushroom' : 'red_mushroom'), min: 5, max: 5 }],
  drops: [D('leather', 0, 2, 1), D('beef', 1, 3, 1)],
  ai: AI_PASSIVE,
  spawn: { biomes: ['mushroom_fields'], light: [9, 15], group: [4, 8], weight: 8, block: 'mycelium' },
  onSpawn(m, o) {
    m.variant = o.variant || 'red';
    m.skinName = m.variant === 'brown' ? 'brown_mooshroom' : 'mooshroom';
  },
  onInteract(m, player, stack) {
    // Suspicious stew from a flower-fed mooshroom, milk from a bowl.
    if (stack && stack.item === 'bowl') {
      shrinkHeld(player, stack);
      dropStack(m.world, m.x, m.y + 1, m.z, mkStack(m.stewFlower ? 'suspicious_stew' : 'mushroom_stew', 1));
      m.stewFlower = null;
      return true;
    }
    return false;
  },
});

defineMob('sheep', {
  category: 'passive', width: 0.9, height: 1.3, eyeHeight: 1.235,
  health: 8, speed: 0.23, xp: 1,
  babyForm: true, breedItems: ['wheat'], shearable: true, dyeable: true,
  shearDrops: [{ item: (m) => `${m.woolColor || 'white'}_wool`, min: 1, max: 3 }],
  drops: [D('mutton', 1, 2, 1)],
  ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'eat_grass', 'wander', 'look_at_player', 'look_random'],
  spawn: { light: [9, 15], group: [4, 4], weight: 12, block: 'grass_block' },
  onSpawn(m, o) {
    m.woolColor = o.woolColor || weightedPick(m.rng, SHEEP_WEIGHTS);
    m.skinName = `sheep_${m.woolColor}`;
  },
  onTick(m) {
    if (m.sheared) m.skinName = 'sheep_sheared';
    else m.skinName = `sheep_${m.woolColor || 'white'}`;
    // Eating a grass block regrows the fleece.
    if (m.eatTicks === 1 && m.sheared) { m.sheared = false; m.shorn = false; }
    if (m.eatTicks > 0 || !m.sheared || m.baby) return;
    if (!m.rng.chance(0.002)) return;
    const gx = Math.floor(m.x), gy = Math.floor(m.y) - 1, gz = Math.floor(m.z);
    const id = m.world.getBlock(gx, gy, gz);
    if (id === bid('grass_block')) {
      m.world.setBlock(gx, gy, gz, bid('dirt'), 0);
      m.eatTicks = 40;
      m.eating = true;
      particles('block', m.x, m.y, m.z, { count: 10, block: id });
    }
  },
  onDeath(m) {
    if (!m.sheared) dropStack(m.world, m.x, m.y + 0.5, m.z, mkStack(`${m.woolColor || 'white'}_wool`, 1));
  },
});

defineMob('chicken', {
  category: 'passive', width: 0.4, height: 0.7, eyeHeight: 0.644,
  health: 4, speed: 0.25, xp: 1,
  babyForm: true, breedItems: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds'],
  immuneToFall: true,
  drops: [D('feather', 0, 2, 1), D('chicken', 1, 1, 0)],
  ai: AI_PASSIVE,
  spawn: { light: [9, 15], group: [4, 4], weight: 10, block: 'grass_block' },
  onSpawn(m) { m.eggTimer = m.rng.range(6000, 12000); },
  onTick(m) {
    // Chickens flap instead of falling.
    if (m.vy < -1.5) { m.vy = -1.5; m.fallDistance = 0; }
    if (m.baby || m.riding) return;
    if (--m.eggTimer <= 0) {
      m.eggTimer = m.rng.range(6000, 12000);
      dropStack(m.world, m.x, m.y + 0.4, m.z, mkStack('egg', 1));
      playAt(m.world, 'chicken_egg', m.x, m.y, m.z, 1, 1);
    }
  },
});

defineMob('rabbit', {
  category: 'passive', width: 0.4, height: 0.5, eyeHeight: 0.425,
  health: 3, speed: 0.3, xp: 1,
  babyForm: true, breedItems: ['carrot', 'golden_carrot', 'dandelion'],
  variants: ['brown', 'white', 'black', 'white_splotched', 'gold', 'salt', 'evil'],
  avoids: ['wolf', 'fox', 'polar_bear'],
  drops: [D('rabbit_hide', 0, 1, 1), D('rabbit', 0, 1, 1)],
  rareDrops: [RD('rabbit_foot', 0.1)],
  ai: ['float', 'panic', 'avoid_entity', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { light: [9, 15], group: [2, 3], weight: 4 },
  onSpawn(m, o) {
    const b = m.world && m.world.biomeAt ? m.world.biomeAt(m.x, m.z) : null;
    const snowy = b && (b.snowy || b.category === 'snowy');
    const desert = b && b.category === 'desert';
    m.variant = o.variant || (snowy ? (m.rng.chance(0.2) ? 'white_splotched' : 'white')
      : desert ? 'gold' : m.rng.pick(['brown', 'brown', 'salt', 'black']));
    m.skinName = `rabbit_${m.variant}`;
    m.hopTimer = 0;
  },
  onTick(m) {
    // Rabbits move in hops rather than a smooth walk.
    if (m.onGround && --m.hopTimer <= 0 && (Math.abs(m.vx) + Math.abs(m.vz)) > 0.4) {
      m.vy = 5.4; m.hopTimer = m.rng.range(6, 14);
    }
    // The Killer Bunny is hostile and fast.
    if (m.variant === 'evil') {
      m.moveSpeed = 0.4;
      if (!m.target) {
        const p = m.nearestPlayer(16);
        if (p) m.setTarget(p);
      }
      m.attackDamage = 8;
    }
  },
});

defineMob('armadillo', {
  category: 'passive', width: 0.7, height: 0.65, eyeHeight: 0.55,
  health: 12, speed: 0.14, xp: 1,
  babyForm: true, breedItems: ['spider_eye'],
  avoids: ['player', 'zombie', 'skeleton', 'creeper'],
  drops: [], rareDrops: [],
  ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['savanna', 'savanna_plateau', 'windswept_savanna', 'badlands'], light: [9, 15], group: [2, 3], weight: 10 },
  onSpawn(m) { m.scuteTimer = m.rng.range(4800, 9600); m.rolledUp = false; m.rollTicks = 0; },
  onTick(m) {
    // Rolls up when a player or hostile mob comes close, unrolls after a beat.
    const threat = near(m, 7, (e) => e !== m && (isTargetablePlayer(e) || (e.category === 'hostile' && !e.removed)));
    if (threat.length) { m.rolledUp = true; m.rollTicks = 60; m.vx *= 0.2; m.vz *= 0.2; }
    else if (m.rollTicks > 0 && --m.rollTicks <= 0) m.rolledUp = false;
    if (m.baby) return;
    if (--m.scuteTimer <= 0) {
      m.scuteTimer = m.rng.range(4800, 9600);
      dropStack(m.world, m.x, m.y + 0.3, m.z, mkStack('scute', 1));
    }
  },
  onInteract(m, player, stack) {
    if (stack && stack.item === 'brush' && !m.baby) {
      dropStack(m.world, m.x, m.y + 0.3, m.z, mkStack('scute', 1));
      return true;
    }
    return false;
  },
});

defineMob('goat', {
  category: 'neutral', width: 0.9, height: 1.3, eyeHeight: 1.2,
  health: 10, damage: 2, speed: 0.2, xp: 1,
  babyForm: true, breedItems: ['wheat'], milkable: true,
  immuneToFall: true,
  drops: [],
  ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['snowy_slopes', 'jagged_peaks', 'frozen_peaks', 'meadow', 'grove', 'stony_peaks'], light: [7, 15], group: [2, 3], weight: 5 },
  onSpawn(m) {
    m.screaming = m.rng.chance(0.02);
    m.hornsLeft = 2;
    m.ramCooldown = m.rng.range(100, 600);
  },
  onTick(m) {
    // Goats jump absurdly far and ram anything that stands still nearby.
    if (m.onGround && m.rng.chance(0.002)) { m.vy = 12.5; m.vx *= 2.4; m.vz *= 2.4; }
    if (m.baby) return;
    if (m.ramCooldown > 0) { m.ramCooldown--; m.ramming = false; return; }
    const victims = near(m, 8, (e) => e !== m && e.type !== 'goat' && (isTargetablePlayer(e) || e.isMob));
    if (!victims.length) return;
    const t = victims[0];
    m.ramming = true;
    m.faceEntity(t, 0.6);
    const dx = t.x - m.x, dz = t.z - m.z;
    const d = Math.hypot(dx, dz) || 1;
    m.vx += (dx / d) * 1.6; m.vz += (dz / d) * 1.6;
    if (d < 1.6) {
      m.attack(t);          // already shoves the victim away from the goat
      m.ramCooldown = m.rng.range(200, 600);
      m.ramming = false;
      // Ramming a solid block knocks a horn loose.
      if (m.hornsLeft > 0 && m.world.isSolid(Math.floor(m.x + dx / d), Math.floor(m.y), Math.floor(m.z + dz / d))) {
        m.hornsLeft--;
        dropStack(m.world, m.x, m.y + 0.8, m.z, mkStack('goat_horn', 1));
      }
    }
  },
});

defineMob('panda', {
  category: 'neutral', width: 1.3, height: 1.25, eyeHeight: 1.1,
  health: 20, damage: 6, speed: 0.15, xp: 1,
  babyForm: true, breedItems: ['bamboo'], tempts: ['bamboo'],
  variants: ['normal', 'lazy', 'worried', 'playful', 'weak', 'aggressive', 'brown'],
  drops: [D('bamboo', 0, 1)],
  ai: AI_NEUTRAL,
  spawn: { biomes: ['bamboo_jungle', 'jungle'], light: [9, 15], group: [1, 2], weight: 1 },
  onSpawn(m, o) {
    m.variant = o.variant || weightedPick(m.rng, [['normal', 40], ['lazy', 10], ['worried', 10],
      ['playful', 10], ['weak', 5], ['aggressive', 5], ['brown', 2]]);
    if (m.variant === 'brown') m.skinName = 'panda_brown';
    if (m.variant === 'weak') { m.maxHealth = 10; m.health = 10; }
  },
  onTick(m) {
    if (m.variant === 'lazy' && m.onGround && m.rng.chance(0.002)) { m.playingDead = true; m.lazyTicks = 200; }
    if (m.playingDead && --m.lazyTicks <= 0) m.playingDead = false;
    if (m.variant === 'worried' && m.world.weather && m.world.weather.raining) { m.shaking = true; m.vx *= 0.4; m.vz *= 0.4; }
    else m.shaking = false;
    if (m.variant === 'playful' && m.onGround && m.rng.chance(0.003)) { m.rolling = true; m.vy = 4; }
    else if (m.rolling && m.onGround) m.rolling = false;
  },
  onHurt(m) {
    if (m.variant === 'aggressive' || m.rng.chance(0.15)) m.angerTicks = 200;
    return true;
  },
});

defineMob('polar_bear', {
  category: 'neutral', width: 1.4, height: 1.4, eyeHeight: 1.3,
  health: 30, damage: 6, speed: 0.25, xp: 1,
  babyForm: true, followRange: 20,
  drops: [D('cod', 0, 2, 1), D('salmon', 0, 2, 1)],
  ai: AI_NEUTRAL,
  spawn: { biomes: ['snowy_plains', 'ice_spikes', 'snowy_beach', 'frozen_ocean', 'deep_frozen_ocean'], light: [7, 15], group: [1, 2], weight: 1 },
  onTick(m) {
    // A mother bear attacks anything that comes near her cub.
    if (m.baby) return;
    const cubs = near(m, 9, (e) => e.type === 'polar_bear' && e.baby);
    if (!cubs.length) return;
    const p = m.nearestPlayer(9);
    if (p && !m.target) { m.setTarget(p); m.angerTicks = 200; }
    m.standing = !!m.target;
  },
});

defineMob('fox', {
  category: 'passive', width: 0.6, height: 0.7, eyeHeight: 0.55,
  health: 10, damage: 2, speed: 0.3, xp: 1,
  babyForm: true, breedItems: ['sweet_berries', 'glow_berries'],
  avoids: ['player', 'wolf', 'polar_bear'],
  canPickUpLoot: true,
  variants: ['red', 'snow'],
  drops: [],
  ai: ['float', 'panic', 'avoid_entity', 'tempt', 'breed', 'follow_parent', 'nearest_attackable_target', 'attack_melee', 'wander', 'look_at_player', 'look_random'],
  targets: ['chicken', 'rabbit', 'cod', 'salmon', 'tropical_fish'],
  spawn: { biomes: ['taiga', 'snowy_taiga', 'old_growth_pine_taiga', 'old_growth_spruce_taiga', 'grove'], light: [7, 15], group: [2, 4], weight: 8 },
  onSpawn(m, o) {
    const b = m.world && m.world.biomeAt ? m.world.biomeAt(m.x, m.z) : null;
    m.variant = o.variant || (b && b.snowy ? 'snow' : 'red');
    m.skinName = m.variant === 'snow' ? 'fox_snow' : 'fox';
    m.canPickUpLoot = true;
  },
  onTick(m) {
    // Foxes are nocturnal: they curl up and sleep through the day.
    const day = m.world.isDay && m.world.isDay();
    m.sleeping = day && !m.target && m.onGround && !m.panicTicks;
    if (m.sleeping) { m.vx *= 0.5; m.vz *= 0.5; }
    if (m.pouncing && m.onGround) m.pouncing = false;
    if (m.target && !m.pouncing && m.onGround && m.distanceTo(m.target) < 6 && m.rng.chance(0.05)) {
      m.pouncing = true;
      const dx = m.target.x - m.x, dz = m.target.z - m.z, d = Math.hypot(dx, dz) || 1;
      m.vx += (dx / d) * 4; m.vz += (dz / d) * 4; m.vy = 6;
    }
  },
});

defineMob('wolf', {
  category: 'neutral', width: 0.6, height: 0.85, eyeHeight: 0.68,
  health: 8, tamedHealth: 20, damage: 3, speed: 0.3, xp: 1, followRange: 16,
  babyForm: true, breedItems: ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit',
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'rotten_flesh'],
  tameItems: ['bone'], tameChance: 0.33, dyeable: true,
  targets: ['sheep', 'rabbit', 'fox', 'skeleton'],
  drops: [],
  ai: AI_PET,
  spawn: { biomes: ['forest', 'taiga', 'snowy_taiga', 'old_growth_pine_taiga', 'old_growth_spruce_taiga', 'grove'], light: [7, 15], group: [4, 4], weight: 5 },
  onSpawn(m) { m.collarColor = 0xe93636; },
  onTick(m) {
    m.skinName = m.angry ? 'wolf_angry' : m.tamed ? 'wolf_tame' : 'wolf';
    if (m.tamed) {
      m.attackDamage = 4;
      // Wet dogs shake themselves off.
      if (m.inWater) m.wetTicks = 100;
      else if (m.wetTicks > 0) { m.wetTicks--; m.shaking = m.wetTicks > 80; }
      // Teleport to the owner when it falls too far behind.
      const o = m.owner;
      if (o && !m.sitting && !m.leashedTo && m.distanceTo(o) > 12 && (m.age & 15) === 0) {
        for (let i = 0; i < 10; i++) {
          if (m.teleportTo(o.x + m.rng.range(-3, 3), o.y, o.z + m.rng.range(-3, 3))) break;
        }
      }
      // Owner's target becomes the pack's target.
      if (o && o.lastAttacked && o.lastAttacked !== m && !m.sitting) m.setTarget(o.lastAttacked);
    } else if (m.target) m.angry = true;
    else if (m.angerTicks <= 0) m.angry = false;
  },
  onInteract(m, player, stack) {
    const item = stack && stack.item;
    if (m.tamed && m.isOwner(player) && item && FOOD_HEAL[item] !== undefined && m.health < m.maxHealth) {
      m.heal(FOOD_HEAL[item]);
      shrinkHeld(player, stack);
      return true;
    }
    return false;
  },
});

// Healing values for pet foods.
const FOOD_HEAL = {
  beef: 3, porkchop: 3, chicken: 2, mutton: 2, rabbit: 3, rotten_flesh: 4,
  cooked_beef: 8, cooked_porkchop: 8, cooked_chicken: 6, cooked_mutton: 6, cooked_rabbit: 5,
  cod: 2, salmon: 2, tropical_fish: 1, pufferfish: 1,
};

defineMob('cat', {
  category: 'passive', width: 0.6, height: 0.7, eyeHeight: 0.6,
  health: 10, damage: 3, speed: 0.3, xp: 1,
  babyForm: true, breedItems: ['cod', 'salmon'],
  tameItems: ['cod', 'salmon'], tameChance: 0.33, dyeable: true,
  targets: ['rabbit', 'chicken', 'baby_turtle'],
  avoids: [],
  variants: ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie', 'all_black'],
  drops: [D('string', 0, 2, 1)],
  ai: AI_PET,
  spawn: { light: [7, 15], group: [1, 1], weight: 2, natural: false },
  onSpawn(m, o) {
    m.variant = o.variant || m.rng.pick(['tabby', 'black', 'red', 'siamese', 'british_shorthair',
      'calico', 'persian', 'ragdoll', 'white', 'jellie']);
    m.skinName = `cat_${m.variant}`;
    m.giftTimer = 0;
  },
  onTick(m) {
    if (!m.tamed) return;
    const o = m.owner;
    if (o && !m.sitting && m.distanceTo(o) > 12 && (m.age & 15) === 0) {
      m.teleportTo(o.x + m.rng.range(-2, 2), o.y, o.z + m.rng.range(-2, 2));
    }
    // Cats sit on their sleeping owner and leave a gift in the morning.
    if (o && o.sleeping) { m.sitting = true; m.giftTimer = 1; }
    else if (m.giftTimer === 1) {
      m.giftTimer = 0;
      if (m.rng.chance(0.7)) {
        dropStack(m.world, m.x, m.y + 0.4, m.z,
          mkStack(m.rng.pick(['string', 'feather', 'rotten_flesh', 'rabbit_hide', 'phantom_membrane']), 1));
      }
    }
  },
});

defineMob('ocelot', {
  category: 'passive', width: 0.6, height: 0.7, eyeHeight: 0.6,
  health: 10, speed: 0.3, xp: 1,
  babyForm: true, breedItems: ['cod', 'salmon'], tempts: ['cod', 'salmon'],
  avoids: ['player'],
  drops: [],
  ai: ['float', 'panic', 'avoid_entity', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['jungle', 'sparse_jungle', 'bamboo_jungle'], light: [9, 15], group: [1, 3], weight: 2 },
  onInteract(m, player, stack) {
    // Ocelots cannot be tamed since 1.14; they gain trust instead.
    if (stack && (stack.item === 'cod' || stack.item === 'salmon')) {
      m.trust = (m.trust || 0) + 1;
      shrinkHeld(player, stack);
      if (m.trust >= 3) { m.trusting = true; m.persistent = true; particles('heart', m.x, m.y + 0.8, m.z, { count: 5 }); }
      return true;
    }
    return false;
  },
});

defineMob('parrot', {
  category: 'passive', width: 0.5, height: 0.9, eyeHeight: 0.8,
  health: 6, speed: 0.4, xp: 1, flying: true,
  tameItems: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds'], tameChance: 0.33,
  variants: ['red_blue', 'blue', 'green', 'yellow_blue', 'gray'],
  drops: [D('feather', 1, 2, 1)],
  ai: ['float', 'sit', 'follow_owner', 'tempt', 'fly_wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['jungle', 'sparse_jungle', 'bamboo_jungle'], light: [9, 15], group: [1, 2], weight: 40 },
  onSpawn(m, o) {
    m.variant = o.variant || m.rng.pick(['red_blue', 'blue', 'green', 'yellow_blue', 'gray']);
    m.skinName = `parrot_${m.variant}`;
  },
  onTick(m) {
    // Gliding: parrots fall slowly and flap upward now and then.
    if (m.vy < -2) m.vy = -2;
    if (!m.onGround && m.rng.chance(0.05)) m.vy += 1.4;
    // Dances near a playing jukebox.
    const j = findBlockNear(m.world, m.x, m.y, m.z, 3, [bid('jukebox')]);
    m.dancing = !!j && m.world.getMeta(j.x, j.y, j.z) > 0;
    // Cookies are poison.
    if (m.eatingCookie) { m.eatingCookie = false; m.hurt(6, srcOf('magic')); }
  },
  onInteract(m, player, stack) {
    if (stack && stack.item === 'cookie') { m.eatingCookie = true; shrinkHeld(player, stack); return true; }
    if (m.tamed && m.isOwner(player) && !stack) { m.sitting = !m.sitting; return true; }
    return false;
  },
});

defineMob('bat', {
  category: 'ambient', width: 0.5, height: 0.9, eyeHeight: 0.45,
  health: 6, speed: 0.3, xp: 0, flying: true, model: 'bat', skin: 'bat',
  drops: [],
  ai: ['fly_wander', 'look_random'],
  spawn: { light: [0, 3], y: [0, 62], group: [1, 3], weight: 10, surface: false },
  onSpawn(m) { m.resting = true; m.restTicks = m.rng.range(100, 600); },
  onTick(m) {
    // Hangs from a ceiling by day, flutters about at night.
    const night = m.world.isNight && m.world.isNight();
    if (m.resting) {
      m.gravity = false;
      m.vx = m.vy = m.vz = 0;
      if (--m.restTicks <= 0 || night || m.nearestPlayer(4)) { m.resting = false; m.restTicks = m.rng.range(200, 800); }
    } else {
      m.gravity = false;
      if (m.rng.chance(0.05)) {
        m.vx += (m.rng.next() - 0.5) * 2;
        m.vy += (m.rng.next() - 0.5) * 1.4;
        m.vz += (m.rng.next() - 0.5) * 2;
      }
      m.vy += 0.2;
      m.vx *= 0.9; m.vy *= 0.86; m.vz *= 0.9;
      if (--m.restTicks <= 0 && !night && m.world.isSolid(Math.floor(m.x), Math.floor(m.y + 1.2), Math.floor(m.z))) {
        m.resting = true; m.restTicks = m.rng.range(200, 1200);
      }
    }
  },
});

// ---- horses and other mounts ---------------------------------------------

const HORSE_COLORS = ['white', 'creamy', 'chestnut', 'brown', 'black', 'gray', 'dark_brown'];

/** Shared behaviour for every member of the horse family. */
function horseCommon(extra) {
  return Object.assign({
    category: 'passive', width: 1.4, height: 1.6, eyeHeight: 1.5,
    speed: 0.225, xp: 1, babyForm: true, rideable: true, saddleable: true,
    breedItems: ['golden_apple', 'golden_carrot', 'enchanted_golden_apple'],
    tempts: ['golden_apple', 'golden_carrot', 'wheat', 'apple', 'sugar', 'hay_block'],
    ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
    onSpawn(m, o) {
      // Vanilla rolls health 15..30, jump 0.4..1.0 and speed 0.1125..0.3375.
      m.maxHealth = o.maxHealth ?? (15 + m.rng.range(0, 8) + m.rng.range(0, 9));
      m.health = m.maxHealth;
      m.jumpStrength = 0.4 + m.rng.next() * 0.4 + m.rng.next() * 0.2;
      m.moveSpeed = 0.1125 + (m.rng.next() + m.rng.next() + m.rng.next()) * 0.075;
      m.temper = 0;
    },
    onTick(m) {
      const rider = m.passengers[0];
      if (!rider) { m.rearing = false; return; }
      if (!m.tamed) {
        // Bucking: an untamed horse throws its rider and gains temper.
        m.rearing = true;
        m.temper += m.rng.range(0, 5);
        if (m.temper >= 100) { m.tame(rider); m.rearing = false; }
        else if (m.rng.chance(0.2)) { m.dismount(rider); rider.vy = 6; }
        return;
      }
      if (!m.saddled) return;
      m.yaw = rider.yaw;
      m.headYaw = rider.yaw;
      const f = (rider.moveForward || 0), s = (rider.moveStrafe || 0);
      if (f || s) {
        const sp = m.moveSpeed * 22;
        // Right vector is (-cos yaw, -sin yaw), matching player.js and
        // vehicles.js. With these signs flipped a saddled horse strafed the
        // opposite way from every other rideable in the game.
        m.vx += (-Math.sin(m.yaw) * f - Math.cos(m.yaw) * s) * sp * 0.05;
        m.vz += (Math.cos(m.yaw) * f - Math.sin(m.yaw) * s) * sp * 0.05;
      }
      if (rider.wantsJump && m.onGround) { m.vy = 10 * m.jumpStrength; rider.wantsJump = false; }
    },
    onInteract(m, player, stack) {
      const item = stack && stack.item;
      if (item && HORSE_FOOD[item] !== undefined) {
        m.heal(HORSE_FOOD[item].heal || 0);
        if (!m.tamed) { m.temper += HORSE_FOOD[item].temper || 0; if (m.temper >= 100) m.tame(player); }
        if (m.baby) m.growTicks = Math.max(0, m.growTicks - (HORSE_FOOD[item].grow || 0));
        shrinkHeld(player, stack);
        particles('heart', m.x, m.y + m.height, m.z, { count: 5 });
        return true;
      }
      if (!stack && !m.baby) { m.mount(player); return true; }
      return false;
    },
  }, extra || {});
}

const HORSE_FOOD = {
  sugar: { heal: 1, temper: 3, grow: 1200 },
  wheat: { heal: 2, temper: 3, grow: 400 },
  apple: { heal: 3, temper: 3, grow: 1200 },
  golden_carrot: { heal: 4, temper: 5, grow: 1200 },
  golden_apple: { heal: 10, temper: 10, grow: 4800 },
  enchanted_golden_apple: { heal: 10, temper: 10, grow: 4800 },
  hay_block: { heal: 20, temper: 0, grow: 3600 },
};

defineMob('horse', horseCommon({
  health: 22, model: 'horse', skin: 'horse',
  variants: HORSE_COLORS,
  drops: [D('leather', 0, 2, 1)],
  spawn: { biomes: ['plains', 'sunflower_plains', 'savanna', 'savanna_plateau', 'meadow'], light: [9, 15], group: [2, 6], weight: 5, block: 'grass_block' },
  onSpawn(m, o) {
    m.maxHealth = 15 + m.rng.range(0, 8) + m.rng.range(0, 9);
    m.health = m.maxHealth;
    m.jumpStrength = 0.4 + m.rng.next() * 0.4 + m.rng.next() * 0.2;
    m.moveSpeed = 0.1125 + (m.rng.next() + m.rng.next() + m.rng.next()) * 0.075;
    m.temper = 0;
    m.variant = o.variant || m.rng.pick(HORSE_COLORS);
    m.skinName = `horse_${m.variant}`;
  },
}));

defineMob('donkey', horseCommon({
  health: 22, model: 'donkey', skin: 'donkey', chestable: true,
  drops: [D('leather', 0, 2, 1)],
  spawn: { biomes: ['plains', 'savanna', 'savanna_plateau', 'meadow'], light: [9, 15], group: [1, 3], weight: 1 },
  onInteract(m, player, stack) {
    if (stack && stack.item === 'chest' && !m.chested) {
      m.chested = true; m.hasChest = true; shrinkHeld(player, stack); return true;
    }
    return false;
  },
}));

defineMob('mule', horseCommon({
  health: 22, model: 'mule', skin: 'mule', chestable: true,
  drops: [D('leather', 0, 2, 1)],
  spawn: { natural: false, weight: 0 },
}));

defineMob('skeleton_horse', horseCommon({
  health: 15, model: 'skeleton_horse', skin: 'skeleton_horse', undead: true,
  drops: [D('bone', 0, 2, 1)],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) {
    m.maxHealth = 15; m.health = 15;
    m.jumpStrength = 0.7; m.moveSpeed = 0.2; m.temper = 0; m.trapped = false;
  },
  onTick(m) {
    // Lightning-spawned traps burst into four skeleton riders.
    if (!m.trapped || m.trapTicks === undefined) return;
    if (--m.trapTicks > 0) return;
    m.trapped = false;
    m.tamed = true;
    m.saddled = true;
    for (let i = 0; i < 4; i++) {
      const h = i === 0 ? m : createMob('skeleton_horse', m.world, m.x + m.rng.range(-2, 2), m.y, m.z + m.rng.range(-2, 2));
      const s = createMob('skeleton', m.world, h ? h.x : m.x, m.y, h ? h.z : m.z, { persistent: true });
      if (s && h) { h.mount(s); h.tamed = true; h.saddled = true; }
    }
  },
}));

defineMob('zombie_horse', horseCommon({
  health: 15, model: 'zombie_horse', skin: 'zombie_horse', undead: true,
  drops: [D('rotten_flesh', 0, 2, 1)],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.maxHealth = 15; m.health = 15; m.jumpStrength = 0.7; m.moveSpeed = 0.2; m.temper = 0; },
}));

defineMob('llama', {
  category: 'neutral', width: 0.9, height: 1.87, eyeHeight: 1.7,
  health: 22, damage: 1, speed: 0.175, xp: 1,
  babyForm: true, breedItems: ['hay_block'], tempts: ['hay_block', 'wheat'],
  chestable: true, rideable: true, dyeable: true,
  variants: ['creamy', 'white', 'brown', 'gray'],
  drops: [D('leather', 0, 2, 1)],
  ai: ['float', 'hurt_by_target', 'attack_ranged', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['windswept_hills', 'windswept_gravelly_hills', 'savanna_plateau', 'windswept_forest'], light: [9, 15], group: [4, 6], weight: 5 },
  onSpawn(m, o) {
    m.variant = o.variant || m.rng.pick(['creamy', 'white', 'brown', 'gray']);
    m.skinName = `llama_${m.variant}`;
    m.strength = m.rng.range(1, 5);
    m.maxHealth = 15 + m.rng.range(0, 8) + m.rng.range(0, 9);
    m.health = m.maxHealth;
    m.carpetColor = null;
  },
  ranged(m, target) {
    // Llamas spit rather than bite.
    const a = aimAt(m, target, 1.5, 0.1);
    shootProjectile('llama_spit', m.world, m, m.x, m.y + m.eyeHeight, m.z, a.dx, a.dy, a.dz, { damage: 1 });
    playAt(m.world, 'llama_spit', m.x, m.y, m.z, 1, 1);
  },
  onInteract(m, player, stack) {
    const item = stack && stack.item;
    if (item === 'chest' && !m.chested) { m.chested = true; m.hasChest = true; shrinkHeld(player, stack); return true; }
    if (item && item.endsWith('_carpet')) { m.carpetColor = item.slice(0, -7); shrinkHeld(player, stack); return true; }
    return false;
  },
});

defineMob('trader_llama', {
  category: 'neutral', width: 0.9, height: 1.87, eyeHeight: 1.7,
  health: 22, damage: 1, speed: 0.175, xp: 1, model: 'trader_llama', skin: 'trader_llama',
  babyForm: true, breedItems: ['hay_block'], chestable: true,
  drops: [D('leather', 0, 2, 1)],
  ai: ['float', 'hurt_by_target', 'attack_ranged', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { natural: false, weight: 0 },
  ranged(m, target) {
    const a = aimAt(m, target, 1.5, 0.1);
    shootProjectile('llama_spit', m.world, m, m.x, m.y + m.eyeHeight, m.z, a.dx, a.dy, a.dz, { damage: 1 });
  },
  onTick(m) {
    // Keeps station on the wandering trader that brought it.
    const t = m.leashHolderTrader;
    if (t && !t.removed && m.distanceTo(t) > 6) m.moveTo(t.x, t.y, t.z, 1.2);
  },
});

defineMob('camel', {
  category: 'passive', width: 1.7, height: 2.375, eyeHeight: 2.1,
  health: 32, speed: 0.09, xp: 1, model: 'camel', skin: 'camel',
  babyForm: true, breedItems: ['cactus'], tempts: ['cactus'],
  rideable: true, saddleable: true,
  drops: [],
  ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['desert'], light: [9, 15], group: [1, 1], weight: 1, natural: false },
  onSpawn(m) { m.sitTicks = 0; m.dashCooldown = 0; m.sitting = false; },
  onTick(m) {
    if (m.dashCooldown > 0) m.dashCooldown--;
    const rider = m.passengers[0];
    // Camels sit down when idle and stand when a rider mounts.
    if (!rider) {
      if (!m.sitting && m.rng.chance(0.001)) { m.sitting = true; m.standTicks = 0; }
      else if (m.sitting && m.nearestPlayer(6)) m.sitting = false;
      return;
    }
    if (m.sitting) { m.sitting = false; m.standTicks = 40; }
    m.yaw = rider.yaw;
    if (rider.wantsDash && m.dashCooldown <= 0 && m.onGround) {
      rider.wantsDash = false;
      m.dashing = true;
      m.dashCooldown = 55;
      m.vx += -Math.sin(m.yaw) * 14;
      m.vz += Math.cos(m.yaw) * 14;
      m.vy = 5;
    } else if (m.dashing && m.onGround && m.dashCooldown < 45) m.dashing = false;
  },
});

defineMob('strider', {
  category: 'passive', width: 0.9, height: 1.7, eyeHeight: 1.5,
  health: 20, speed: 0.175, xp: 1, fireImmune: true,
  babyForm: true, breedItems: ['warped_fungus'], tempts: ['warped_fungus', 'warped_fungus_on_a_stick'],
  rideable: true, saddleable: true, canSwim: false,
  drops: [D('string', 2, 5, 1)],
  ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { dimension: DIM_NETHER, biomes: ['nether_wastes', 'basalt_deltas', 'crimson_forest', 'warped_forest', 'soul_sand_valley'], light: [0, 15], group: [1, 3], weight: 60, block: 'lava' },
  onTick(m) {
    // Striders walk on lava and shiver when they leave it.
    const inLava = m.inLava || m.world.getBlock(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z)) === bid('lava');
    m.frozen = !inLava && !m.riding;
    m.shaking = m.frozen;
    if (inLava) {
      m.gravity = false;
      m.vy = Math.max(m.vy, 0);
      const surface = Math.floor(m.y) + 1;
      if (m.world.getBlock(Math.floor(m.x), surface, Math.floor(m.z)) !== bid('lava')) m.y = surface - 0.05;
      m.moveSpeed = 0.32;
    } else {
      m.gravity = true;
      m.moveSpeed = 0.088;
    }
    const rider = m.passengers[0];
    if (rider && m.saddled) {
      const held = rider.getHeldItem ? rider.getHeldItem() : null;
      if (held && held.item === 'warped_fungus_on_a_stick') {
        m.yaw = rider.yaw;
        m.vx += -Math.sin(m.yaw) * 0.4;
        m.vz += Math.cos(m.yaw) * 0.4;
      }
    }
  },
});

// ---- villagers and traders ------------------------------------------------

const PROFESSION_LIST = ['unemployed', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer',
  'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd',
  'toolsmith', 'weaponsmith'];
const WORKSTATIONS = {
  armorer: 'blast_furnace', butcher: 'smoker', cartographer: 'cartography_table',
  cleric: 'brewing_stand', farmer: 'composter', fisherman: 'barrel', fletcher: 'fletching_table',
  leatherworker: 'cauldron', librarian: 'lectern', mason: 'stonecutter', shepherd: 'loom',
  toolsmith: 'smithing_table', weaponsmith: 'grindstone',
};

defineMob('villager', {
  category: 'passive', width: 0.6, height: 1.95, eyeHeight: 1.62,
  health: 20, speed: 0.5, xp: 0, model: 'villager', skin: 'villager',
  babyForm: true, breedItems: ['bread', 'carrot', 'potato', 'beetroot'],
  avoids: ['zombie', 'zombie_villager', 'husk', 'drowned', 'vindicator', 'evoker', 'pillager', 'ravager', 'vex', 'illusioner', 'zoglin'],
  drops: [],
  ai: ['float', 'avoid_entity', 'panic', 'open_door', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m, o) {
    m.profession = o.profession || (m.baby ? 'unemployed' : m.rng.pick(PROFESSION_LIST));
    m.villagerLevel = o.level || 1;
    m.villagerXp = 0;
    m.trades = null;
    m.workstation = null;
    m.restockTimer = 0;
    m.gossip = Object.create(null);
    m.willingToBreed = false;
    m.food = 0;
    m.skinName = `villager_${m.profession}`;
  },
  onTick(m) {
    m.skinName = `villager_${m.profession || 'unemployed'}`;
    // Panic when an illager or zombie is close: the avoid goal handles the
    // running, this just makes sure the villager stops trading.
    if (m.panicTicks > 0) m.trading = null;

    // Claim a workstation and pick up the matching profession.
    if ((m.age % 200) === 0) {
      if (m.profession === 'unemployed') {
        for (const prof in WORKSTATIONS) {
          const b = findBlockNear(m.world, m.x, m.y, m.z, 6, [bid(WORKSTATIONS[prof])]);
          if (b) { m.profession = prof; m.workstation = b; m.trades = null; break; }
        }
      } else if (WORKSTATIONS[m.profession]) {
        m.workstation = findBlockNear(m.world, m.x, m.y, m.z, 8, [bid(WORKSTATIONS[m.profession])]) || m.workstation;
      }
    }
    // Restock twice a day at the workstation.
    if (m.restockTimer > 0) m.restockTimer--;
    if (m.workstation && m.restockTimer <= 0 && m.world.isDay && m.world.isDay()) {
      if (m.distanceToSq(m.workstation.x + 0.5, m.workstation.y, m.workstation.z + 0.5) > 4) {
        if ((m.age & 15) === 0) m.moveTo(m.workstation.x + 0.5, m.workstation.y, m.workstation.z + 0.5, 0.6);
      } else if (m.trades) {
        for (const t of m.trades) t.uses = 0;
        m.restockTimer = 12000;
        m.working = true;
        particles('magic', m.x, m.y + 1.8, m.z, { count: 3 });
      }
    } else m.working = false;

    // Farmers work the crops around them.
    if (m.profession === 'farmer' && (m.age % 80) === 0 && !m.baby) {
      const wheat = findBlockNear(m.world, m.x, m.y, m.z, 5, [bid('wheat')]);
      if (wheat && m.world.getMeta(wheat.x, wheat.y, wheat.z) >= 7) {
        m.world.setBlock(wheat.x, wheat.y, wheat.z, bid('wheat'), 0);
        dropStack(m.world, wheat.x + 0.5, wheat.y + 0.3, wheat.z + 0.5, mkStack('wheat', 1));
        m.food += 3;
      }
    }
    // Breeding needs food and a bed; the food part is modelled here.
    m.willingToBreed = m.food >= 12 && !m.baby;
    if (m.willingToBreed && m.loveTicks <= 0 && m.breedCooldown <= 0 && m.rng.chance(0.002)) {
      m.loveTicks = 600; m.food -= 12;
    }
    // Nearby zombies terrify villagers.
    if ((m.age & 15) === 0) {
      const z = near(m, 8, (e) => e.isMob && (e.type === 'zombie' || e.type === 'husk' || e.type === 'drowned' || e.def?.illager));
      if (z.length) m.panicTicks = 100;
    }
  },
  onInteract(m, player, stack) {
    if (m.baby || m.profession === 'nitwit' || m.profession === 'unemployed') return false;
    if (m.panicTicks > 0 || m.sleeping) return false;
    m.trading = player;
    try { Game.ui?.screens?.open?.('trading', { villager: m }); } catch { /* optional */ }
    return true;
  },
  onDeath(m, source) {
    // A zombie kill can turn a villager rather than killing it outright.
    const killer = source && (source.entity || source.direct);
    if (!killer || (killer.type !== 'zombie' && killer.type !== 'zombie_villager' && killer.type !== 'husk' && killer.type !== 'drowned')) return;
    const chance = Game.difficulty === DIFFICULTY.HARD ? 1 : Game.difficulty === DIFFICULTY.NORMAL ? 0.5 : 0;
    if (!m.rng.chance(chance)) return;
    const zv = createMob('zombie_villager', m.world, m.x, m.y, m.z, { persistent: m.persistent });
    if (zv) { zv.profession = m.profession; zv.villagerLevel = m.villagerLevel; }
  },
});

defineMob('wandering_trader', {
  category: 'passive', width: 0.6, height: 1.95, eyeHeight: 1.62,
  health: 20, speed: 0.5, xp: 0, model: 'wandering_trader', skin: 'wandering_trader',
  drops: [],
  ai: ['float', 'panic', 'avoid_entity', 'wander', 'look_at_player', 'look_random'],
  avoids: ['zombie', 'husk', 'drowned', 'pillager', 'vindicator', 'evoker', 'illusioner', 'zoglin'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) {
    m.persistent = true;
    m.despawnDelay = 48000;      // 40 minutes, like vanilla
    m.trades = null;
  },
  onTick(m) {
    if (--m.despawnDelay <= 0) { m.remove(); return; }
    // Drinks invisibility at night and milk at dawn.
    const night = m.world.isNight && m.world.isNight();
    if (night && !m.hasEffect('invisibility')) m.addEffect('invisibility', 6000, 0);
    if (!night && m.hasEffect('invisibility')) m.removeEffect('invisibility');
  },
  onInteract(m, player) {
    try { Game.ui?.screens?.open?.('trading', { villager: m }); } catch { /* optional */ }
    return true;
  },
});

// ---- golems and constructs ------------------------------------------------

defineMob('iron_golem', {
  category: 'neutral', width: 1.4, height: 2.7, eyeHeight: 2.5,
  health: 100, damage: 7, speed: 0.25, xp: 0, knockbackResist: 1, followRange: 24,
  model: 'iron_golem', skin: 'iron_golem',
  immuneToFall: true,
  targets: ['zombie', 'husk', 'skeleton', 'creeper', 'spider', 'pillager', 'vindicator', 'evoker', 'ravager', 'witch', 'zoglin'],
  drops: [D('iron_ingot', 3, 5), D('poppy', 0, 2)],
  ai: ['float', 'hurt_by_target', 'defend_village', 'nearest_attackable_target', 'attack_melee', 'wander', 'look_at_player', 'look_random'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.persistent = true; m.flowerTicks = 0; },
  onAttack(m, target) {
    // 7 - 21 damage plus a big vertical launch.
    const extra = m.rng.range(0, 14);
    try {
      const kbSrc = srcOf('mob', m, m); kbSrc.knockback = 1.2;
      target.hurt?.(extra, kbSrc);
      target.vy = Math.max(target.vy || 0, 6.5);
    } catch { /* optional */ }
  },
  onTick(m) {
    // Offers a poppy to nearby villagers now and then.
    if (m.flowerTicks > 0) { m.flowerTicks--; m.offeringFlower = true; return; }
    m.offeringFlower = false;
    if (m.rng.chance(0.0005) && near(m, 6, (e) => e.type === 'villager').length) m.flowerTicks = 400;
  },
});

defineMob('snow_golem', {
  category: 'passive', width: 0.7, height: 1.9, eyeHeight: 1.7,
  health: 4, speed: 0.2, xp: 0, model: 'snow_golem', skin: 'snow_golem',
  shearable: true,
  shearDrops: [{ item: 'carved_pumpkin', min: 1, max: 1 }],
  targets: ['zombie', 'skeleton', 'creeper', 'spider'],
  drops: [D('snowball', 0, 15)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_ranged', 'wander', 'look_at_player', 'look_random'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.persistent = true; },
  ranged(m, target) {
    const a = aimAt(m, target, 1.6, 0.2);
    shootProjectile('snowball', m.world, m, m.x, m.y + m.eyeHeight, m.z, a.dx, a.dy, a.dz, { damage: 0, blazeDamage: 3 });
    playAt(m.world, 'snowball', m.x, m.y, m.z, 1, 1);
  },
  onTick(m) {
    // Melts in hot biomes and in the rain; leaves a snow trail.
    const b = m.world.biomeAt ? m.world.biomeAt(m.x, m.z) : null;
    if (b && b.temperature > 1.0) m.hurt(1, srcOf('on_fire'));
    if (m.world.isRainingAt && m.world.isRainingAt(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z))) {
      if ((m.age & 15) === 0) m.hurt(1, srcOf('drown'));
    }
    if (m.onGround && (m.age & 3) === 0 && griefingAllowed(m.world)) {
      const x = Math.floor(m.x), y = Math.floor(m.y), z = Math.floor(m.z);
      if (m.world.getBlock(x, y, z) === 0 && m.world.isSolid(x, y - 1, z) && b && b.temperature < 0.8) {
        m.world.setBlock(x, y, z, bid('snow'), 0);
      }
    }
  },
});

defineMob('armor_stand', {
  category: 'passive', width: 0.5, height: 1.975, eyeHeight: 1.7,
  health: 20, speed: 0, xp: 0, model: 'armor_stand', skin: 'armor_stand',
  noAI: true, noGravity: false, pushable: false,
  drops: [D('armor_stand', 1, 1)],
  ai: [],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.persistent = true; m.pose = 'default'; },
  onInteract(m, player, stack) {
    // Swap whatever the player is holding into the matching armour slot.
    if (!stack || !stack.item) return false;
    const name = stack.item;
    let slot = null;
    if (name.endsWith('_helmet') || name === 'turtle_helmet' || name.endsWith('_head') || name.endsWith('_skull')) slot = 'head';
    else if (name.endsWith('_chestplate') || name === 'elytra') slot = 'chest';
    else if (name.endsWith('_leggings')) slot = 'legs';
    else if (name.endsWith('_boots')) slot = 'feet';
    else slot = 'mainhand';
    const old = m.equipment[slot];
    m.setEquipment(slot, mkStack(name, 1, { damage: stack.damage || 0 }));
    shrinkHeld(player, stack);
    if (old) dropStack(m.world, m.x, m.y + 1, m.z, old);
    return true;
  },
  onDeath(m) {
    for (const slot in m.equipment) {
      const s = m.equipment[slot];
      if (s) dropStack(m.world, m.x, m.y + 1, m.z, s);
    }
  },
});

// ---- aquatic and insect life ---------------------------------------------

/** Swim steering shared by every water mob. */
function swimTick(m, speed) {
  m.gravity = false;
  if (!m.inWater) { m.gravity = true; return; }
  if (m.rng.chance(0.06) || m._swimDir === undefined) {
    const a = m.rng.next() * Math.PI * 2, p = (m.rng.next() - 0.5) * 0.8;
    m._swimDir = { x: Math.cos(a) * Math.cos(p), y: Math.sin(p), z: Math.sin(a) * Math.cos(p) };
  }
  const d = m._swimDir;
  m.vx += d.x * speed; m.vy += d.y * speed; m.vz += d.z * speed;
  m.vx *= 0.86; m.vy *= 0.86; m.vz *= 0.86;
  m.yaw = Math.atan2(-m.vx, m.vz);
  // Do not swim out of the water.
  if (m.world.getBlock(Math.floor(m.x), Math.floor(m.y + m.height + 0.4), Math.floor(m.z)) === 0) m.vy = Math.min(m.vy, 0);
}

/** Builder for the four small fish, which only differ in drops and skin. */
function fishMob(name, extra) {
  return defineMob(name, Object.assign({
    category: 'water', width: 0.5, height: 0.3, eyeHeight: 0.2,
    health: 3, speed: 0.12, xp: 1, waterMob: true, canSwim: true, model: name, skin: name,
    drops: [D(name === 'tropical_fish' ? 'tropical_fish' : name, 1, 1)],
    ai: AI_WATER,
    spawn: { light: [0, 15], y: [40, 62], group: [3, 6], weight: 10, surface: false, block: 'water' },
    onTick(m) { swimTick(m, 0.35); },
  }, extra || {}));
}

fishMob('cod', { spawn: { light: [0, 15], y: [40, 62], group: [3, 6], weight: 10, surface: false, block: 'water' } });
fishMob('salmon', { width: 0.7, height: 0.4, drops: [D('salmon', 1, 1)] });
fishMob('tropical_fish', {
  width: 0.5, height: 0.4,
  onSpawn(m) { m.variant = m.rng.range(0, 21); m.patternColor = m.rng.range(0, 15); },
});
fishMob('pufferfish', {
  width: 0.7, height: 0.7, health: 3, drops: [D('pufferfish', 1, 1)],
  onSpawn(m) { m.puffState = 0; m.puffTicks = 0; },
  onTick(m) {
    swimTick(m, 0.3);
    // Puffs up in stages when something comes close, and stings on contact.
    const threat = near(m, 4, (e) => e !== m && (isTargetablePlayer(e) || (e.isMob && e.category !== 'water')));
    const want = !threat.length ? 0 : m.distanceTo(threat[0]) < 2 ? 2 : 1;
    if (want > m.puffState) { m.puffState = want; playAt(m.world, 'puff', m.x, m.y, m.z, 1, 1); }
    else if (want < m.puffState && ++m.puffTicks > 60) { m.puffState = want; m.puffTicks = 0; }
    if (m.puffState !== 2) return;
    for (const e of near(m, 1.2, (e) => e !== m && (isTargetablePlayer(e) || e.isMob))) {
      if (e.hurt?.(m.puffState, srcOf('mob', m, m))) e.addEffect?.('poison', 140, 0);
    }
  },
});

defineMob('squid', {
  category: 'water', width: 0.8, height: 0.8, eyeHeight: 0.4,
  health: 10, speed: 0.2, xp: 1, waterMob: true, model: 'squid', skin: 'squid',
  drops: [D('ink_sac', 1, 3, 1)],
  ai: AI_WATER,
  spawn: { light: [0, 15], y: [30, 62], group: [2, 4], weight: 10, surface: false, block: 'water' },
  onTick(m) { swimTick(m, 0.3); },
  onHurt(m) {
    // Ink cloud when attacked.
    particles('smoke', m.x, m.y + 0.4, m.z, { count: 30, spread: 1.2, color: 0x0a0a12, life: 2 });
    return true;
  },
});

defineMob('glow_squid', {
  category: 'water', width: 0.8, height: 0.8, eyeHeight: 0.4,
  health: 10, speed: 0.2, xp: 1, waterMob: true, model: 'glow_squid', skin: 'glow_squid',
  drops: [D('glow_ink_sac', 1, 3, 1)],
  ai: AI_WATER,
  spawn: { light: [0, 0], y: [0, 30], group: [2, 4], weight: 10, surface: false, block: 'water' },
  onTick(m) {
    swimTick(m, 0.28);
    if ((m.age & 7) === 0) particles('magic', m.x, m.y + 0.4, m.z, { count: 1, color: 0x4dd0e1 });
  },
});

defineMob('dolphin', {
  category: 'water', width: 0.9, height: 0.6, eyeHeight: 0.45,
  health: 10, damage: 3, speed: 0.35, xp: 1, waterMob: true, amphibious: true,
  model: 'dolphin', skin: 'dolphin', followRange: 24,
  targets: ['guardian', 'elder_guardian', 'drowned'],
  drops: [D('cod', 0, 1, 1)],
  ai: ['swim_wander', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'look_at_player', 'look_random'],
  spawn: { biomes: ['ocean', 'deep_ocean', 'lukewarm_ocean', 'warm_ocean'], light: [0, 15], y: [45, 62], group: [3, 5], weight: 2, surface: false, block: 'water' },
  onSpawn(m) { m.treasurePos = null; m.airSupply = 4800; },
  onTick(m) {
    swimTick(m, 0.5);
    // Grants Dolphin's Grace to swimmers nearby.
    for (const p of near(m, 6, isTargetablePlayer)) {
      if (p.inWater) p.addEffect?.('dolphins_grace', 100, 0);
    }
    // Leads players to the nearest structure after being fed raw fish.
    if (m.leadingTicks > 0) {
      m.leadingTicks--;
      if (!m.treasurePos && m.world.generator && m.world.generator.findStructure) {
        try { m.treasurePos = m.world.generator.findStructure('shipwreck', m.x, m.z); } catch { m.treasurePos = null; }
      }
      if (m.treasurePos) {
        m.moveTo(m.treasurePos.x, m.y, m.treasurePos.z, 1.4);
        if ((m.age & 7) === 0) particles('magic', m.x, m.y + 0.6, m.z, { count: 2 });
      }
    }
  },
  onInteract(m, player, stack) {
    if (stack && (stack.item === 'cod' || stack.item === 'salmon' || stack.item === 'tropical_fish')) {
      shrinkHeld(player, stack);
      m.leadingTicks = 2400;
      particles('magic', m.x, m.y + 0.6, m.z, { count: 7 });
      return true;
    }
    return false;
  },
});

defineMob('axolotl', {
  category: 'water', width: 0.75, height: 0.42, eyeHeight: 0.3,
  health: 14, damage: 2, speed: 0.2, xp: 1, waterMob: true, amphibious: true,
  model: 'axolotl', skin: 'axolotl', babyForm: true,
  breedItems: ['tropical_fish_bucket', 'tropical_fish'],
  variants: ['lucy', 'wild', 'gold', 'cyan', 'blue'],
  targets: ['squid', 'glow_squid', 'cod', 'salmon', 'tropical_fish', 'pufferfish', 'tadpole', 'drowned', 'guardian', 'elder_guardian'],
  drops: [],
  ai: ['swim_wander', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'tempt', 'breed', 'look_at_player'],
  spawn: { biomes: ['lush_caves'], light: [0, 15], y: [0, 62], group: [4, 6], weight: 10, surface: false, block: 'water' },
  onSpawn(m, o) {
    m.variant = o.variant || weightedPick(m.rng, [['lucy', 1], ['wild', 1], ['gold', 1], ['cyan', 1], ['blue', 0.008]]);
    m.skinName = `axolotl_${m.variant}`;
    m.playDeadCooldown = 0;
  },
  onTick(m) {
    swimTick(m, 0.32);
    if (m.playingDead) {
      m.vx *= 0.4; m.vz *= 0.4;
      if (--m.playDeadTicks <= 0) m.playingDead = false;
      return;
    }
    if (m.playDeadCooldown > 0) m.playDeadCooldown--;
    if (!m.inWater && m.onGround) m.hurt(1, srcOf('drown'));
  },
  onHurt(m, amount) {
    // Plays dead and regenerates when badly hurt in water.
    if (m.inWater && m.health - amount <= m.maxHealth * 0.5 && m.playDeadCooldown <= 0) {
      m.playingDead = true; m.playDeadTicks = 200; m.playDeadCooldown = 400;
      m.addEffect('regeneration', 200, 0);
    }
    return true;
  },
  onAttack(m, target) {
    // Killing a hostile grants the nearby player Regeneration.
    if (target && target.health <= 0) {
      for (const p of near(m, 20, isTargetablePlayer)) {
        p.removeEffect?.('mining_fatigue');
        p.addEffect?.('regeneration', 100, 0);
      }
    }
  },
});

defineMob('turtle', {
  category: 'passive', width: 1.2, height: 0.4, eyeHeight: 0.3,
  health: 30, speed: 0.12, xp: 1, model: 'turtle', skin: 'turtle', amphibious: true,
  babyForm: true, breedItems: ['seagrass'], tempts: ['seagrass'], growTicks: 48000,
  drops: [D('seagrass', 0, 2, 1)],
  ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['beach'], light: [9, 15], group: [2, 5], weight: 5, block: 'sand' },
  onSpawn(m) { m.homeX = Math.floor(m.x); m.homeZ = Math.floor(m.z); m.hasEgg = false; m.digging = false; m.digTicks = 0; },
  onTick(m) {
    if (m.inWater) { m.moveSpeed = 0.24; m.gravity = false; m.vy += 0.1; m.vy *= 0.9; }
    else { m.moveSpeed = 0.06; m.gravity = true; }
    if (!m.hasEgg) return;
    // Head home and dig a nest in the sand.
    const dx = m.homeX + 0.5 - m.x, dz = m.homeZ + 0.5 - m.z;
    if (dx * dx + dz * dz > 4) { if ((m.age & 7) === 0) m.moveTo(m.homeX + 0.5, m.y, m.homeZ + 0.5, 1); return; }
    const gx = Math.floor(m.x), gy = Math.floor(m.y), gz = Math.floor(m.z);
    if (m.world.getBlock(gx, gy - 1, gz) !== bid('sand')) return;
    m.digging = true;
    if (++m.digTicks < 200) return;
    m.digging = false; m.digTicks = 0; m.hasEgg = false;
    if (m.world.getBlock(gx, gy, gz) === 0) m.world.setBlock(gx, gy, gz, bid('turtle_egg'), m.rng.range(0, 3));
  },
  onBreed(a, b, baby) { a.hasEgg = true; a.digTicks = 0; if (baby) baby.remove(); },
  onGrowUp(m) { dropStack(m.world, m.x, m.y + 0.2, m.z, mkStack('turtle_scute', 1)); },
});

defineMob('tadpole', {
  category: 'water', width: 0.4, height: 0.3, eyeHeight: 0.2,
  health: 6, speed: 0.15, xp: 1, waterMob: true, model: 'tadpole', skin: 'tadpole',
  drops: [],
  ai: AI_WATER,
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.tadpoleTicks = 24000; },
  onTick(m) {
    swimTick(m, 0.28);
    if (--m.tadpoleTicks > 0) return;
    const b = m.world.biomeAt ? m.world.biomeAt(m.x, m.z) : null;
    const v = !b ? 'temperate' : b.temperature > 1.0 ? 'warm' : b.temperature < 0.3 ? 'cold' : 'temperate';
    createMob('frog', m.world, m.x, m.y, m.z, { variant: v });
    m.remove();
  },
});

defineMob('frog', {
  category: 'passive', width: 0.5, height: 0.5, eyeHeight: 0.4,
  health: 10, damage: 0, speed: 0.1, xp: 1, model: 'frog', skin: 'frog', amphibious: true,
  breedItems: ['slimeball'], tempts: ['slimeball'],
  variants: ['temperate', 'warm', 'cold'],
  targets: ['slime', 'magma_cube'],
  drops: [],
  ai: ['float', 'panic', 'tempt', 'breed', 'nearest_attackable_target', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['swamp', 'mangrove_swamp'], light: [9, 15], group: [2, 5], weight: 10 },
  onSpawn(m, o) {
    m.variant = o.variant || 'temperate';
    m.skinName = `frog_${m.variant}`;
    m.tongueTicks = 0;
  },
  onTick(m) {
    if (m.onGround && m.rng.chance(0.02)) { m.vy = 6; m.vx *= 1.6; m.vz *= 1.6; }
    m.croaking = m.rng.chance(0.005) || (m.croaking && m.rng.chance(0.9));
    if (m.tongueTicks > 0) { m.tongueTicks--; return; }
    // Eating a small slime or magma cube leaves a froglight.
    const prey = near(m, 3, (e) => (e.type === 'slime' || e.type === 'magma_cube') && e.slimeSize === 1);
    if (!prey.length) return;
    const p = prey[0];
    m.tongueTicks = 40;
    p.hurt(20, srcOf('mob', m, m));
    const light = p.type === 'magma_cube' ? 'pearlescent_froglight'
      : m.variant === 'warm' ? 'ochre_froglight' : m.variant === 'cold' ? 'verdant_froglight' : 'ochre_froglight';
    dropStack(m.world, p.x, p.y + 0.3, p.z, mkStack(light, 1));
  },
  onBreed(a, b, baby) {
    // Frogs lay spawn in water instead of producing a baby directly.
    if (baby) baby.remove();
    const w = a.world;
    for (let i = 0; i < 3; i++) createMob('tadpole', w, a.x + a.rng.range(-1, 1), a.y, a.z + a.rng.range(-1, 1));
  },
});

defineMob('bee', {
  category: 'neutral', width: 0.7, height: 0.6, eyeHeight: 0.45,
  health: 10, damage: 2, speed: 0.3, xp: 1, flying: true, arthropod: false,
  model: 'bee', skin: 'bee', babyForm: true,
  breedItems: ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
    'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony'],
  drops: [],
  ai: ['fly_wander', 'hurt_by_target', 'attack_melee', 'tempt', 'breed', 'look_at_player'],
  spawn: { biomes: ['plains', 'sunflower_plains', 'flower_forest', 'meadow', 'cherry_grove'], light: [9, 15], group: [2, 3], weight: 5 },
  onSpawn(m) { m.hasNectar = false; m.hivePos = null; m.stingerless = false; m.pollinateTicks = 0; },
  onTick(m) {
    m.gravity = false;
    m.vy += 0.16; m.vy *= 0.86;
    // A bee that has stung something dies shortly afterwards.
    if (m.stingerless) {
      m.stingDeath = (m.stingDeath === undefined ? 60 : m.stingDeath) - 1;
      if (m.stingDeath <= 0) { m.hurt(20, srcOf('generic')); return; }
    }
    m.angry = !!m.target;
    if (m.target) { m.happy = false; return; }
    // Find a flower, hover over it, then head back to the hive.
    if (!m.hasNectar) {
      const f = findBlockNear(m.world, m.x, m.y, m.z, 8, FLOWER_IDS());
      if (f) {
        m.moveTo(f.x + 0.5, f.y + 1, f.z + 0.5, 1);
        if (m.distanceToSq(f.x + 0.5, f.y + 1, f.z + 0.5) < 1.6) {
          if (++m.pollinateTicks > 100) { m.hasNectar = true; m.pollinateTicks = 0; m.happy = true; }
          particles('magic', m.x, m.y, m.z, { count: 1 });
        }
      }
      return;
    }
    if (!m.hivePos) m.hivePos = findBlockNear(m.world, m.x, m.y, m.z, 16, [bid('beehive'), bid('bee_nest')]);
    if (!m.hivePos) return;
    m.moveTo(m.hivePos.x + 0.5, m.hivePos.y + 0.5, m.hivePos.z + 0.5, 1.1);
    if (m.distanceToSq(m.hivePos.x + 0.5, m.hivePos.y + 0.5, m.hivePos.z + 0.5) > 2) return;
    m.hasNectar = false;
    // Adding nectar raises the hive's honey level.
    const meta = m.world.getMeta(m.hivePos.x, m.hivePos.y, m.hivePos.z);
    if (meta < 5) m.world.setBlock(m.hivePos.x, m.hivePos.y, m.hivePos.z, m.world.getBlock(m.hivePos.x, m.hivePos.y, m.hivePos.z), meta + 1);
  },
  onAttack(m, target) {
    // One sting, poison, then the bee dies.
    if (m.stingerless) return;
    m.stingerless = true;
    target.addEffect?.('poison', Game.difficulty === DIFFICULTY.HARD ? 360 : 200, 0);
    m.stingDeath = 60;
  },
});

let _flowerIds = null;
/** Ids of every small flower, cached after the first call. */
function FLOWER_IDS() {
  if (_flowerIds) return _flowerIds;
  const names = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
    'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
    'sunflower', 'lilac', 'rose_bush', 'peony', 'torchflower', 'pitcher_plant', 'flowering_azalea'];
  _flowerIds = names.map(bid).filter((v) => v > 0);
  return _flowerIds;
}

defineMob('allay', {
  category: 'passive', width: 0.35, height: 0.6, eyeHeight: 0.5,
  health: 20, speed: 0.3, xp: 0, flying: true, model: 'allay', skin: 'allay',
  drops: [],
  ai: ['fly_wander', 'follow_owner', 'look_at_player'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.wantedItem = null; m.carried = null; m.noteBlockPos = null; m.persistent = true; },
  onTick(m) {
    m.gravity = false;
    m.vy += 0.16; m.vy *= 0.88;
    m.dancing = !!findBlockNear(m.world, m.x, m.y, m.z, 3, [bid('jukebox')]);
    if (!m.wantedItem) return;
    // Collect matching drops, then hand them to the owner or a note block.
    if (!m.carried) {
      const items = near(m, 16, (e) => e.type === 'item' && e.stack && e.stack.item === m.wantedItem);
      if (items.length) {
        const it = items[0];
        m.moveTo(it.x, it.y, it.z, 1.4);
        if (m.distanceTo(it) < 1.2) { m.carried = it.stack; m.holdingItem = it.stack.item; it.remove(); }
      }
      return;
    }
    const dest = m.noteBlockPos || (m.owner ? { x: m.owner.x, y: m.owner.y, z: m.owner.z } : null);
    if (!dest) return;
    m.moveTo(dest.x, dest.y + 1, dest.z, 1.4);
    if (m.distanceToSq(dest.x, dest.y + 1, dest.z) > 4) return;
    dropStack(m.world, m.x, m.y, m.z, m.carried);
    m.carried = null; m.holdingItem = null;
  },
  onInteract(m, player, stack) {
    if (stack && stack.item) {
      m.wantedItem = stack.item;
      m.owner = player;
      m.holdingItem = stack.item;
      shrinkHeld(player, stack);
      particles('note', m.x, m.y + 0.8, m.z, { count: 3 });
      return true;
    }
    if (m.carried) { dropStack(m.world, m.x, m.y, m.z, m.carried); m.carried = null; m.holdingItem = null; return true; }
    return false;
  },
});

defineMob('sniffer', {
  category: 'passive', width: 1.9, height: 1.75, eyeHeight: 1.6,
  health: 14, speed: 0.1, xp: 1, model: 'sniffer', skin: 'sniffer',
  babyForm: true, breedItems: ['torchflower_seeds'], tempts: ['torchflower_seeds'], growTicks: 48000,
  drops: [],
  ai: ['float', 'panic', 'tempt', 'breed', 'follow_parent', 'wander', 'look_at_player', 'look_random'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.digCooldown = m.rng.range(100, 400); m.sniffing = false; m.digTicks = 0; },
  onTick(m) {
    if (m.baby) return;
    if (m.digCooldown > 0) { m.digCooldown--; m.sniffing = m.digCooldown > 100 && m.digCooldown < 200; return; }
    // Digs ancient seeds out of grass and dirt.
    const gx = Math.floor(m.x), gy = Math.floor(m.y) - 1, gz = Math.floor(m.z);
    const id = m.world.getBlock(gx, gy, gz);
    if (id !== bid('grass_block') && id !== bid('dirt') && id !== bid('coarse_dirt') && id !== bid('podzol')) {
      m.digCooldown = 60; return;
    }
    m.digging = true;
    if (++m.digTicks < 120) return;
    m.digging = false; m.digTicks = 0; m.digCooldown = m.rng.range(600, 1200);
    dropStack(m.world, m.x, m.y + 0.5, m.z, mkStack(m.rng.chance(0.5) ? 'torchflower_seeds' : 'pitcher_pod', 1));
    particles('block', m.x, m.y, m.z, { count: 12, block: id });
  },
  onBreed(a, b, baby) {
    if (baby) baby.remove();
    dropStack(a.world, a.x, a.y + 0.5, a.z, mkStack('sniffer_egg', 1));
  },
});

// ===========================================================================
// Hostile mobs
// ===========================================================================

// ---- the zombie family ----------------------------------------------------

/** Shared zombie behaviour: door breaking, reinforcements, baby speed. */
function zombieTick(m) {
  if (m.baby) m.moveSpeed = m.def.speed * 1.5;
  // Hard-mode zombies chew through wooden doors.
  if (Game.difficulty === DIFFICULTY.HARD && m.target && griefingAllowed(m.world)) {
    const yaw = Math.atan2(m.target.x - m.x, -(m.target.z - m.z));
    const fx = Math.floor(m.x + Math.sin(yaw));
    const fz = Math.floor(m.z - Math.cos(yaw));
    const fy = Math.floor(m.y);
    const id = m.world.getBlock(fx, fy, fz);
    const def = getBlock(id);
    if (def && def.model === 'door' && def.name.indexOf('iron') < 0) {
      m._doorKey = fx + ',' + fy + ',' + fz;
      m._doorTicks = (m._doorTicks || 0) + 1;
      m.breakingDoor = m._doorTicks / 240;
      if (m._doorTicks >= 240) {
        m._doorTicks = 0;
        m.world.setBlock(fx, fy, fz, 0, 0);
        m.world.setBlock(fx, fy + 1, fz, 0, 0);
        playAt(m.world, 'door_break', fx, fy, fz, 1, 1);
      }
    } else { m._doorTicks = 0; m.breakingDoor = 0; }
  }
  // Standing in water for 30 seconds turns a zombie into a drowned.
  if (m.def.convertsToDrowned) {
    if (m.submerged || (m.inWater && m.world.getBlock(Math.floor(m.x), Math.floor(m.y + m.height), Math.floor(m.z)) === bid('water'))) {
      m.drownTicks = (m.drownTicks || 0) + 1;
      if (m.drownTicks >= 600) {
        const d = createMob('drowned', m.world, m.x, m.y, m.z, { baby: m.baby, persistent: m.persistent });
        if (d) { d.yaw = m.yaw; m.remove(); }
      }
    } else m.drownTicks = 0;
  }
}

/** Zombies call for help when hurt: a free zombie spawns nearby. */
function zombieReinforcements(m) {
  if (Game.difficulty === DIFFICULTY.EASY || Game.difficulty === DIFFICULTY.PEACEFUL) return;
  m.reinforcementCalls = m.reinforcementCalls || 0;
  if (m.reinforcementCalls >= 3 || !m.rng.chance(Game.difficulty === DIFFICULTY.HARD ? 0.1 : 0.05)) return;
  const r = m.rng;
  for (let i = 0; i < 12; i++) {
    const x = m.x + r.range(-20, 20), z = m.z + r.range(-20, 20);
    const y = m.world.getHeight(Math.floor(x), Math.floor(z));
    if (y < 1 || m.world.isSolid(Math.floor(x), y, Math.floor(z))) continue;
    const help = createMob(m.type, m.world, x, y, z, { persistent: false });
    if (!help) continue;
    m.reinforcementCalls++;
    help.reinforcementCalls = 3;
    help.setTarget(m.target);
    break;
  }
}

const ZOMBIE_EQUIP = [
  { slot: 'mainhand', item: 'iron_shovel', chance: 0.03 },
  { slot: 'mainhand', item: 'iron_sword', chance: 0.02 },
];

defineMob('zombie', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.74,
  health: 20, armor: 2, damage: 3, speed: 0.23, xp: 5, followRange: 35,
  undead: true, burnsInDay: true, babyForm: true, convertsToDrowned: true,
  model: 'zombie', skin: 'zombie',
  equipment: ZOMBIE_EQUIP, armorRoll: true,
  drops: [D('rotten_flesh', 0, 2, 1)],
  rareDrops: [RD('iron_ingot', 0.025), RD('carrot', 0.025), RD('potato', 0.025)],
  ai: [...AI_UNDEAD, 'break_door'],
  targets: ['player', 'villager', 'iron_golem', 'turtle'],
  spawn: { light: [0, 7], group: [2, 4], weight: 100, y: [0, 127] },
  onSpawn(m) {
    m.drownTicks = 0; m.reinforcementCalls = 0; m._doorTicks = 0;
    if (!m.baby && m.rng.chance(0.05)) { m.baby = true; m.applySize(); }
  },
  onTick: zombieTick,
  onHurt(m) { zombieReinforcements(m); return true; },
});

defineMob('zombie_villager', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.74,
  health: 20, armor: 2, damage: 3, speed: 0.23, xp: 5, followRange: 35,
  undead: true, burnsInDay: true, babyForm: true, convertsToDrowned: false,
  model: 'zombie_villager', skin: 'zombie_villager',
  equipment: ZOMBIE_EQUIP, armorRoll: true,
  drops: [D('rotten_flesh', 0, 2, 1)],
  rareDrops: [RD('iron_ingot', 0.025), RD('carrot', 0.025), RD('potato', 0.025)],
  ai: AI_UNDEAD,
  targets: ['player', 'villager', 'iron_golem'],
  spawn: { light: [0, 7], group: [1, 1], weight: 5 },
  onSpawn(m, o) { m.profession = o.profession || m.rng.pick(PROFESSION_LIST); m.drownTicks = 0; m.reinforcementCalls = 0; m.curing = 0; },
  onTick(m) {
    zombieTick(m);
    // Curing: a golden apple after a weakness potion turns it back.
    if (m.curing <= 0) return;
    if (--m.curing > 0) { if ((m.age & 7) === 0) particles('angry', m.x, m.y + 2, m.z, { count: 1 }); return; }
    const v = createMob('villager', m.world, m.x, m.y, m.z, { profession: m.profession, persistent: true });
    if (v) { v.villagerLevel = m.villagerLevel || 1; m.remove(); }
  },
  onInteract(m, player, stack) {
    if (stack && stack.item === 'golden_apple' && m.hasEffect('weakness')) {
      shrinkHeld(player, stack);
      m.curing = 2400 + m.rng.range(0, 2400);
      return true;
    }
    return false;
  },
});

defineMob('husk', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.74,
  health: 20, armor: 2, damage: 3, speed: 0.23, xp: 5, followRange: 35,
  undead: true, burnsInDay: false, babyForm: true, model: 'husk', skin: 'husk',
  equipment: ZOMBIE_EQUIP, armorRoll: true,
  drops: [D('rotten_flesh', 0, 2, 1)],
  rareDrops: [RD('iron_ingot', 0.025)],
  ai: AI_HOSTILE,
  targets: ['player', 'villager', 'iron_golem'],
  spawn: { biomes: ['desert'], light: [0, 7], group: [2, 4], weight: 80 },
  onSpawn(m) { m.drownTicks = 0; m.reinforcementCalls = 0; },
  onAttack(m, target) {
    const secs = Game.difficulty === DIFFICULTY.HARD ? 14 : 7;
    target.addEffect?.('hunger', secs * 20, 0);
  },
  onTick(m) {
    // Husks turn into ordinary zombies if they get wet.
    if (!m.submerged) { m.drownTicks = 0; return; }
    if (++m.drownTicks < 600) return;
    const z = createMob('zombie', m.world, m.x, m.y, m.z, { baby: m.baby });
    if (z) m.remove();
  },
});

defineMob('drowned', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.74,
  health: 20, armor: 2, damage: 3, speed: 0.23, xp: 5, followRange: 35,
  undead: true, burnsInDay: true, babyForm: true, amphibious: true, aquaticBreather: true,
  model: 'drowned', skin: 'drowned',
  equipment: [
    { slot: 'mainhand', item: 'trident', chance: 0.0625, dropChance: 0.08 },
    { slot: 'mainhand', item: 'fishing_rod', chance: 0.03 },
    { slot: 'offhand', item: 'nautilus_shell', chance: 0.03 },
  ],
  drops: [D('rotten_flesh', 0, 2, 1)],
  rareDrops: [RD('copper_ingot', 0.11), RD('gold_ingot', 0.025)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_ranged', 'attack_melee', 'swim_wander', 'wander', 'look_at_player', 'look_random'],
  targets: ['player', 'villager', 'iron_golem', 'turtle', 'axolotl'],
  spawn: { light: [0, 7], y: [0, 62], group: [2, 3], weight: 5, block: 'water', surface: false },
  onSpawn(m) { m.airSupply = 4800; },
  onTick(m) {
    // Drowned only leave the water to hunt at night.
    const night = m.world.isNight && m.world.isNight();
    if (!m.inWater && !night && m.target) m.setTarget(null);
    if (m.inWater) { m.gravity = false; m.vy += 0.12; m.vy *= 0.9; }
    else m.gravity = true;
  },
  ranged(m, target) {
    const held = m.equipment.mainhand;
    if (!held || held.item !== 'trident') return;
    if (m.attackCooldown > 0) return;
    m.attackCooldown = 40;
    const a = aimAt(m, target, 1.6, 0.06);
    shootProjectile('trident', m.world, m, m.x, m.y + m.eyeHeight, m.z, a.dx, a.dy, a.dz, { damage: 8, speed: 1.6 });
    playAt(m.world, 'trident_throw', m.x, m.y, m.z, 1, 1);
  },
});

// ---- skeletons ------------------------------------------------------------

/** Shared skeleton bow logic. */
function skeletonRanged(arrowType, effects) {
  return (m, target) => {
    if (m.attackCooldown > 0) return;
    m.attackCooldown = bowCooldown();
    m.aiming = true;
    bowShot(m, target, { type: arrowType, damage: 4, effects: effects || null });
  };
}

defineMob('skeleton', {
  category: 'hostile', width: 0.6, height: 1.99, eyeHeight: 1.74,
  health: 20, armor: 0, damage: 2, speed: 0.25, xp: 5, followRange: 16,
  undead: true, burnsInDay: true, model: 'skeleton', skin: 'skeleton',
  equipment: [{ slot: 'mainhand', item: 'bow', chance: 1, dropChance: 0.085 }], armorRoll: true,
  drops: [D('arrow', 0, 2, 1), D('bone', 0, 2, 1)],
  ai: AI_BOW,
  targets: ['player', 'iron_golem', 'wolf'],
  spawn: { light: [0, 7], group: [2, 4], weight: 100 },
  ranged: skeletonRanged('arrow', null),
  onDeath(m, source) {
    // A skeleton killed by a charged creeper drops its skull.
    const k = source && (source.entity || source.direct);
    if (k && k.type === 'creeper' && k.charged) dropStack(m.world, m.x, m.y, m.z, mkStack('skeleton_skull', 1));
  },
});

defineMob('stray', {
  category: 'hostile', width: 0.6, height: 1.99, eyeHeight: 1.74,
  health: 20, damage: 2, speed: 0.25, xp: 5, followRange: 16,
  undead: true, burnsInDay: true, model: 'stray', skin: 'stray',
  equipment: [{ slot: 'mainhand', item: 'bow', chance: 1 }], armorRoll: true,
  drops: [D('arrow', 0, 2, 1), D('bone', 0, 2, 1)],
  rareDrops: [RD('tipped_arrow', 0.5, 1, 1)],
  ai: AI_BOW,
  spawn: { biomes: ['snowy_plains', 'ice_spikes', 'snowy_slopes', 'frozen_peaks', 'snowy_taiga'], light: [0, 7], group: [2, 4], weight: 80 },
  ranged: skeletonRanged('tipped_arrow', [{ name: 'slowness', ticks: 600, level: 0 }]),
});

defineMob('bogged', {
  category: 'hostile', width: 0.6, height: 1.99, eyeHeight: 1.74,
  health: 16, damage: 2, speed: 0.25, xp: 5, followRange: 16,
  undead: true, burnsInDay: true, model: 'bogged', skin: 'bogged',
  equipment: [{ slot: 'mainhand', item: 'bow', chance: 1 }],
  shearable: true, shearDrops: [{ item: 'red_mushroom', min: 2, max: 2 }],
  drops: [D('arrow', 0, 2, 1), D('bone', 0, 2, 1)],
  ai: AI_BOW,
  spawn: { biomes: ['swamp', 'mangrove_swamp'], light: [0, 7], group: [1, 2], weight: 30 },
  ranged: skeletonRanged('tipped_arrow', [{ name: 'poison', ticks: 100, level: 0 }]),
});

defineMob('wither_skeleton', {
  category: 'hostile', width: 0.7, height: 2.4, eyeHeight: 2.1,
  health: 20, armor: 4, damage: 8, speed: 0.24, xp: 5, followRange: 16,
  undead: true, fireImmune: true, model: 'wither_skeleton', skin: 'wither_skeleton',
  equipment: [{ slot: 'mainhand', item: 'stone_sword', chance: 1, dropChance: 0.085 }],
  drops: [D('bone', 0, 2, 1), D('coal', 0, 1, 1)],
  rareDrops: [RD('wither_skeleton_skull', 0.025)],
  ai: AI_HOSTILE,
  targets: ['player', 'iron_golem'],
  spawn: { dimension: DIM_NETHER, biomes: ['nether_wastes', 'soul_sand_valley'], light: [0, 11], group: [1, 5], weight: 80 },
  onAttack(m, target) {
    const secs = Game.difficulty === DIFFICULTY.HARD ? 10 : 5;
    if (Game.difficulty !== DIFFICULTY.EASY) target.addEffect?.('wither', secs * 20, 0);
  },
});

// ---- creeper --------------------------------------------------------------

const MUSIC_DISCS = ['music_disc_13', 'music_disc_cat', 'music_disc_blocks', 'music_disc_chirp',
  'music_disc_far', 'music_disc_mall', 'music_disc_mellohi', 'music_disc_stal', 'music_disc_strad',
  'music_disc_ward', 'music_disc_11', 'music_disc_wait'];

defineMob('creeper', {
  category: 'hostile', width: 0.6, height: 1.7, eyeHeight: 1.45,
  health: 20, damage: 0, speed: 0.25, xp: 5, followRange: 16,
  model: 'creeper', skin: 'creeper',
  drops: [D('gunpowder', 0, 2, 1)],
  ai: ['float', 'creeper_swell', 'hurt_by_target', 'nearest_attackable_target', 'avoid_entity', 'wander', 'look_at_player', 'look_random'],
  avoids: ['cat', 'ocelot'],
  targets: ['player'],
  spawn: { light: [0, 7], group: [2, 3], weight: 100 },
  onSpawn(m) { m.fuse = 0; m.swell = 0; m.fuseTicks = 0; m.charged = false; m.ignited = false; },
  onTick(m) {
    m.powered = m.charged;
    if (m.charged) m.skinName = 'creeper_charged';
    const t = m.target;
    const close = (m.ignited) || (t && m.distanceTo(t) < 3 && m.canSee(t));
    if (close) {
      if (m.fuse === 0) playAt(m.world, 'creeper_hiss', m.x, m.y, m.z, 1, 0.5);
      m.fuse++;
      if (m.fuse >= 30) { m.explodeSelf(m.charged ? 7 : 3); return; }
    } else if (m.fuse > 0) m.fuse = Math.max(0, m.fuse - 1);
    m.fuseTicks = m.fuse;
    m.swell = clamp(m.fuse / 30, 0, 1);
  },
  onInteract(m, player, stack) {
    if (stack && stack.item === 'flint_and_steel') { m.ignited = true; return true; }
    return false;
  },
  onDeath(m, source) {
    // Killed by a skeleton's arrow: drops a music disc.
    const direct = source && source.direct;
    const shooter = direct && direct.shooter;
    const killer = shooter || (source && source.entity);
    if (!killer) return;
    const t = killer.type;
    if (t === 'skeleton' || t === 'stray' || t === 'bogged' || t === 'wither_skeleton') {
      dropStack(m.world, m.x, m.y + 0.5, m.z, mkStack(m.rng.pick(MUSIC_DISCS), 1));
    }
  },
});

// ---- spiders --------------------------------------------------------------

/** Wall climbing plus the light-level truce shared by both spiders. */
function spiderTick(m) {
  // Climbing: a solid block at body height in the direction of travel.
  const sx = Math.abs(m.vx) > 0.05 ? Math.sign(m.vx) : 0;
  const sz = Math.abs(m.vz) > 0.05 ? Math.sign(m.vz) : 0;
  const bx = Math.floor(m.x + sx * (m.width * 0.5 + 0.25));
  const bz = Math.floor(m.z + sz * (m.width * 0.5 + 0.25));
  const by = Math.floor(m.y + 0.5);
  m.climbing = (sx !== 0 || sz !== 0) && m.world.isSolid(bx, by, bz);
  if (m.climbing) { m.vy = 2.0; m.fallDistance = 0; }
  // Spiders are neutral in bright light unless already provoked.
  const light = m.world.getLight(Math.floor(m.x), Math.floor(m.y + 1), Math.floor(m.z));
  m.neutral = light >= 12;
  if (m.neutral && m.target && m.lastHurtByTicks <= 0) m.setTarget(null);
}

defineMob('spider', {
  category: 'hostile', width: 1.4, height: 0.9, eyeHeight: 0.65,
  health: 16, damage: 2, speed: 0.3, xp: 5, followRange: 16,
  arthropod: true, model: 'spider', skin: 'spider',
  drops: [D('string', 0, 2, 1)],
  rareDrops: [RD('spider_eye', 0.33)],
  ai: ['float', 'leap_at_target', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'wander', 'look_at_player', 'look_random'],
  spawn: { light: [0, 7], group: [1, 4], weight: 100 },
  onTick: spiderTick,
  onSpawn(m) {
    // A small share of spiders spawn with a rider.
    if (Game.difficulty === DIFFICULTY.PEACEFUL || !m.rng.chance(0.01)) return;
    const rider = m.rng.chance(0.8) ? 'skeleton' : 'cave_spider';
    const s = createMob(rider, m.world, m.x, m.y, m.z, {});
    if (s) m.mount(s);
  },
});

defineMob('cave_spider', {
  category: 'hostile', width: 0.7, height: 0.5, eyeHeight: 0.45,
  health: 12, damage: 2, speed: 0.3, xp: 5, followRange: 16,
  arthropod: true, model: 'cave_spider', skin: 'cave_spider',
  drops: [D('string', 0, 2, 1)],
  rareDrops: [RD('spider_eye', 0.33)],
  ai: ['float', 'leap_at_target', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'wander', 'look_at_player', 'look_random'],
  spawn: { light: [0, 7], group: [1, 2], weight: 10, natural: false },
  onTick: spiderTick,
  onAttack(m, target) {
    if (Game.difficulty === DIFFICULTY.EASY || Game.difficulty === DIFFICULTY.PEACEFUL) return;
    target.addEffect?.('poison', Game.difficulty === DIFFICULTY.HARD ? 300 : 140, 0);
  },
});

defineMob('silverfish', {
  category: 'hostile', width: 0.4, height: 0.3, eyeHeight: 0.2,
  health: 8, damage: 1, speed: 0.25, xp: 5, followRange: 16,
  arthropod: true, model: 'silverfish', skin: 'silverfish',
  drops: [],
  ai: AI_HOSTILE,
  spawn: { light: [0, 7], y: [0, 63], group: [1, 2], weight: 10, natural: false },
  onHurt(m) {
    // Calls every silverfish out of the stone around it.
    if (m.summonedHelp) return true;
    m.summonedHelp = true;
    const r = 5;
    for (let dx = -r; dx <= r; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -r; dz <= r; dz++) {
      const x = Math.floor(m.x) + dx, y = Math.floor(m.y) + dy, z = Math.floor(m.z) + dz;
      if (m.world.getBlock(x, y, z) !== bid('infested_stone')) continue;
      m.world.setBlock(x, y, z, 0, 0);
      createMob('silverfish', m.world, x + 0.5, y, z + 0.5, {});
      return true;
    }
    return true;
  },
});

defineMob('endermite', {
  category: 'hostile', width: 0.4, height: 0.3, eyeHeight: 0.2,
  health: 8, damage: 2, speed: 0.25, xp: 3, followRange: 16,
  arthropod: true, model: 'endermite', skin: 'endermite',
  drops: [],
  ai: AI_HOSTILE,
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.lifeTicks = 0; },
  onTick(m) { if (!m.persistent && ++m.lifeTicks > 2400) m.remove(); },
});

// ---- enderman -------------------------------------------------------------

const ENDERMAN_CARRIABLE = ['grass_block', 'dirt', 'coarse_dirt', 'podzol', 'sand', 'red_sand',
  'gravel', 'clay', 'mycelium', 'netherrack', 'dandelion', 'poppy', 'blue_orchid', 'allium',
  'azure_bluet', 'red_tulip', 'oxeye_daisy', 'cornflower', 'red_mushroom', 'brown_mushroom',
  'cactus', 'melon', 'pumpkin', 'tnt', 'crimson_fungus', 'warped_fungus'];

defineMob('enderman', {
  category: 'neutral', width: 0.6, height: 2.9, eyeHeight: 2.55,
  health: 40, damage: 7, speed: 0.3, xp: 5, followRange: 64,
  model: 'enderman', skin: 'enderman',
  drops: [D('ender_pearl', 0, 1, 1)],
  ai: ['float', 'teleport_random', 'stare_aggro', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'wander', 'look_at_player', 'look_random'],
  targets: ['player', 'endermite'],
  spawn: { light: [0, 7], group: [1, 4], weight: 10 },
  onSpawn(m) { m.carrying = null; m.teleporting = false; m.screaming = false; },
  onTick(m) {
    // Water and rain hurt, and both make it blink away.
    const wet = m.inWater || (m.world.isRainingAt && m.world.isRainingAt(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z)));
    if (wet) {
      m.hurt(1, srcOf('drown'));
      m.teleportRandom(32);
    }
    m.screaming = !!m.target;
    if (m.target) {
      // Endermen close distance by teleporting rather than walking.
      if (m.distanceTo(m.target) > 8 && m.rng.chance(0.05)) {
        const t = m.target;
        m.teleportTo(t.x + m.rng.range(-2, 2), t.y, t.z + m.rng.range(-2, 2));
      }
      return;
    }
    // Aggro when a player looks straight at the head from under 64 blocks.
    const p = m.nearestPlayer(64);
    if (p && !p.hasEffect?.('invisibility') && !wearingPumpkin(p) && looksAt(p, m)) {
      m.setTarget(p);
      m.angerTicks = 400;
      playAt(m.world, 'enderman_stare', m.x, m.y, m.z, 1, 1);
      return;
    }
    // Block carrying.
    if (!griefingAllowed(m.world)) return;
    if (!m.carrying) {
      if (!m.rng.chance(0.002)) return;
      const ids = ENDERMAN_CARRIABLE.map(bid).filter((v) => v > 0);
      const b = findBlockNear(m.world, m.x, m.y, m.z, 2, ids);
      if (!b) return;
      m.carrying = getBlock(m.world.getBlock(b.x, b.y, b.z)).name;
      m.heldBlock = m.carrying;
      m.world.setBlock(b.x, b.y, b.z, 0, 0);
    } else if (m.rng.chance(0.002)) {
      const x = Math.floor(m.x), y = Math.floor(m.y), z = Math.floor(m.z);
      if (m.world.getBlock(x, y, z) === 0 && m.world.isSolid(x, y - 1, z)) {
        m.world.setBlock(x, y, z, bid(m.carrying), 0);
        m.carrying = null; m.heldBlock = null;
      }
    }
  },
  onHurt(m, amount, source) {
    // Ranged attacks never connect: the enderman blinks out first.
    if (source && source.projectile) { m.teleportRandom(32); return false; }
    if (m.rng.chance(0.5)) m.teleportRandom(32);
    return true;
  },
  onDeath(m) {
    if (m.carrying) dropStack(m.world, m.x, m.y, m.z, mkStack(m.carrying, 1));
  },
});

/** True when the player is wearing a carved pumpkin (endermen ignore them). */
function wearingPumpkin(p) {
  const h = p.inventory && p.inventory.getArmor ? p.inventory.getArmor(0) : null;
  return !!(h && (h.item === 'carved_pumpkin' || h.item === 'jack_o_lantern'));
}

/** True when `viewer` is looking within ~5 degrees of the mob's head. */
function looksAt(viewer, mob) {
  const dx = mob.x - viewer.x;
  const dy = (mob.y + mob.eyeHeight) - (viewer.y + (viewer.eyeHeight || 1.62));
  const dz = mob.z - viewer.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.001 || len > 64) return false;
  const lx = -Math.sin(viewer.yaw) * Math.cos(viewer.pitch);
  const ly = -Math.sin(viewer.pitch);
  const lz = Math.cos(viewer.yaw) * Math.cos(viewer.pitch);
  const dot = (dx * lx + dy * ly + dz * lz) / len;
  return dot > 1 - 0.025 / len && mob.canSee(viewer);
}

// ---- slimes ---------------------------------------------------------------

/** Sets up a slime or magma cube for a given size (1, 2 or 4). */
function slimeSetup(m, size) {
  m.slimeSize = size;
  m.sizeScale = size;
  m.maxHealth = size * size;
  m.health = m.maxHealth;
  // Vanilla damage per size: slime 0/2/4, magma cube 3/4/6.
  m.attackDamage = m.type === 'magma_cube' ? (size === 1 ? 3 : size === 2 ? 4 : 6) : (size === 1 ? 0 : size);
  m.xpReward = size;
  m.moveSpeed = 0.2 + 0.1 * size;
  m.applySize();
  m.jumpTimer = m.rng.range(20, 40);
  m.squish = 0;
}

/** Hopping movement plus the squish value the model reads. */
function slimeTick(m, jumpPower) {
  if (m.squish > 0) m.squish *= 0.6;
  if (!m.onGround) return;
  if (--m.jumpTimer > 0) { m.vx *= 0.6; m.vz *= 0.6; return; }
  m.jumpTimer = m.target ? m.rng.range(8, 14) : m.rng.range(20, 60);
  const t = m.target;
  let yaw = m.yaw;
  if (t) yaw = Math.atan2(-(t.x - m.x), t.z - m.z);
  else if (m.rng.chance(0.4)) yaw = m.rng.next() * Math.PI * 2;
  m.yaw = yaw;
  const speed = jumpPower * (0.4 + m.slimeSize * 0.12);
  m.vy = jumpPower;
  m.vx = -Math.sin(yaw) * speed;
  m.vz = Math.cos(yaw) * speed;
  m.squish = 1;
  playAt(m.world, m.type === 'magma_cube' ? 'magma_cube_jump' : 'slime_jump', m.x, m.y, m.z, 0.5, 1);
  // Slimes damage anything they land on.
  if (!m.target) return;
  for (const e of near(m, m.width * 0.7 + 0.5, (e) => e !== m && (isTargetablePlayer(e) || e.type === 'iron_golem'))) {
    if (m.attackCooldown <= 0) m.attack(e);
  }
}

/** Splits a dying slime into smaller copies. */
function slimeSplit(m) {
  if (m.slimeSize <= 1) return;
  const n = 2 + m.rng.int(3);           // 2..4, like vanilla
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const child = createMob(m.type, m.world, m.x + Math.cos(a) * 0.5, m.y + 0.1, m.z + Math.sin(a) * 0.5,
      { slimeSize: m.slimeSize >> 1 });
    if (child) { child.vx = Math.cos(a) * 2; child.vz = Math.sin(a) * 2; child.vy = 2; }
  }
}

defineMob('slime', {
  // Base size is one "slime unit"; slimeSetup scales it by 1, 2 or 4.
  category: 'hostile', width: 0.51, height: 0.51, eyeHeight: 0.4,
  health: 4, damage: 2, speed: 0.3, xp: 2, followRange: 16,
  model: 'slime', skin: 'slime',
  drops: [],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'wander', 'look_at_player'],
  spawn: { light: [0, 7], y: [0, 40], group: [1, 4], weight: 100, surface: false },
  onSpawn(m, o) { slimeSetup(m, o.slimeSize || (m.rng.chance(0.5) ? 1 : m.rng.chance(0.5) ? 2 : 4)); },
  onTick(m) { slimeTick(m, 8.0); },
  onDeath(m) {
    slimeSplit(m);
    if (m.slimeSize > 1) {
      const n = m.rng.range(0, 2);
      for (let i = 0; i < n; i++) dropStack(m.world, m.x, m.y + 0.3, m.z, mkStack('slimeball', 1));
    }
  },
});

defineMob('magma_cube', {
  category: 'hostile', width: 0.51, height: 0.51, eyeHeight: 0.4,
  health: 4, damage: 3, speed: 0.3, xp: 2, followRange: 16, fireImmune: true, armor: 3,
  model: 'magma_cube', skin: 'magma_cube',
  drops: [],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'wander', 'look_at_player'],
  spawn: { dimension: DIM_NETHER, light: [0, 15], group: [1, 4], weight: 100, surface: false },
  onSpawn(m, o) { slimeSetup(m, o.slimeSize || (m.rng.chance(0.5) ? 1 : m.rng.chance(0.5) ? 2 : 4)); },
  onTick(m) {
    slimeTick(m, 9.5);
    if ((m.age & 3) === 0) particles('flame', m.x, m.y + 0.2, m.z, { count: 1, spread: m.width * 0.4 });
  },
  onDeath(m) {
    slimeSplit(m);
    if (m.slimeSize > 1) {
      const n = m.rng.range(0, 1);
      for (let i = 0; i < n; i++) dropStack(m.world, m.x, m.y + 0.3, m.z, mkStack('magma_cream', 1));
    }
  },
});

// ---- nether hostiles ------------------------------------------------------

defineMob('blaze', {
  category: 'hostile', width: 0.6, height: 1.8, eyeHeight: 1.5,
  health: 20, armor: 0, damage: 6, speed: 0.23, xp: 10, followRange: 48,
  fireImmune: true, flying: true, model: 'blaze', skin: 'blaze',
  drops: [D('blaze_rod', 0, 1, 1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'ranged_fireball', 'attack_melee', 'fly_wander', 'look_at_player'],
  spawn: { dimension: DIM_NETHER, light: [0, 11], group: [2, 3], weight: 10, natural: false },
  onSpawn(m) { m.burstLeft = 0; m.burstTimer = 0; m.shootCooldown = 60; m.charging = false; },
  onTick(m) {
    m.gravity = false;
    // Hover: blazes bob toward the height of their target.
    const t = m.target;
    const wantY = t ? t.y + 1.2 : m.y;
    m.vy += clamp(wantY - m.y, -1, 1) * 0.6;
    m.vy *= 0.85; m.vx *= 0.91; m.vz *= 0.91;
    if (m.fireTicks > 0 && (m.age & 3) === 0) m.fireTicks = 0;
    if ((m.age & 1) === 0) particles('flame', m.x, m.y + 1, m.z, { count: 1, spread: 0.5 });
    if (!t) { m.charging = false; return; }
    m.faceEntity(t, 0.5);
    // Three fireballs in a burst, then a long cooldown.
    if (m.burstLeft > 0) {
      if (--m.burstTimer > 0) return;
      m.burstTimer = 6;
      m.burstLeft--;
      const a = aimAt(m, t, 1.4, 0.0);
      shootProjectile('small_fireball', m.world, m, m.x, m.y + m.eyeHeight, m.z, a.dx, a.dy, a.dz, { damage: 5, fire: true });
      playAt(m.world, 'blaze_shoot', m.x, m.y, m.z, 1, 1);
      if (m.burstLeft === 0) { m.shootCooldown = 100; m.charging = false; }
      return;
    }
    if (--m.shootCooldown > 0) return;
    if (!m.canSee(t) || m.distanceTo(t) > 48) return;
    m.burstLeft = 3; m.burstTimer = 1; m.charging = true;
  },
});

defineMob('ghast', {
  category: 'hostile', width: 4, height: 4, eyeHeight: 2.6,
  health: 10, damage: 0, speed: 0.15, xp: 5, followRange: 64,
  fireImmune: true, flying: true, model: 'ghast', skin: 'ghast',
  drops: [D('ghast_tear', 0, 1, 1), D('gunpowder', 0, 2, 1)],
  ai: ['fly_wander', 'hurt_by_target', 'nearest_attackable_target', 'ranged_fireball', 'look_at_player'],
  spawn: { dimension: DIM_NETHER, light: [0, 15], group: [1, 1], weight: 50, surface: false },
  onSpawn(m) { m.shootCooldown = 40; m.charging = false; m.chargeTicks = 0; },
  onTick(m) {
    m.gravity = false;
    // Drifts, never lands.
    if (m.rng.chance(0.02) || m._driftX === undefined) {
      m._driftX = (m.rng.next() - 0.5) * 1.2;
      m._driftY = (m.rng.next() - 0.5) * 0.8;
      m._driftZ = (m.rng.next() - 0.5) * 1.2;
    }
    m.vx += m._driftX * 0.1; m.vy += m._driftY * 0.1; m.vz += m._driftZ * 0.1;
    m.vx *= 0.9; m.vy *= 0.9; m.vz *= 0.9;
    const t = m.target;
    if (!t || !m.canSee(t)) { m.charging = false; m.chargeTicks = 0; return; }
    m.faceEntity(t, 0.2);
    if (--m.shootCooldown > 0) return;
    // Ten ticks of glowing eyes before the shot.
    m.charging = true;
    if (++m.chargeTicks < 20) return;
    m.chargeTicks = 0; m.charging = false; m.shootCooldown = 60;
    const a = aimAt(m, t, 1.0, 0.0);
    shootProjectile('fireball', m.world, m, m.x + a.dx * 2, m.y + m.eyeHeight, m.z + a.dz * 2, a.dx, a.dy, a.dz,
      { damage: 6, explosionPower: 1, deflectable: true });
    playAt(m.world, 'ghast_shoot', m.x, m.y, m.z, 4, 1);
  },
});

/** Piglins are only hostile to players who are not wearing gold. */
function wearingGold(p) {
  const inv = p.inventory;
  if (!inv || !inv.getArmor) return false;
  for (let i = 0; i < 4; i++) {
    const s = inv.getArmor(i);
    if (s && s.item && s.item.indexOf('golden_') === 0) return true;
  }
  return false;
}

const BARTER_LOOT = [
  ['soul_sand', 8, 2, 8], ['quartz', 20, 8, 16], ['glowstone_dust', 20, 5, 12],
  ['magma_cream', 20, 2, 6], ['ender_pearl', 10, 2, 4], ['string', 20, 3, 9],
  ['fire_charge', 40, 1, 1], ['gravel', 40, 8, 16], ['leather', 40, 4, 10],
  ['nether_brick', 40, 4, 16], ['obsidian', 40, 1, 1], ['crying_obsidian', 40, 1, 3],
  ['iron_nugget', 10, 9, 36], ['netherite_hoe', 1, 1, 1], ['enchanted_book', 5, 1, 1],
  ['iron_boots', 8, 1, 1], ['splash_potion', 8, 1, 1], ['spectral_arrow', 10, 6, 12],
];

defineMob('piglin', {
  category: 'neutral', width: 0.6, height: 1.95, eyeHeight: 1.79,
  health: 16, damage: 5, speed: 0.35, xp: 5, followRange: 16,
  babyForm: true, model: 'piglin', skin: 'piglin', canPickUpLoot: true,
  equipment: [
    { slot: 'mainhand', item: 'golden_sword', chance: 0.5, dropChance: 0.085 },
    { slot: 'mainhand', item: 'crossbow', chance: 0.5, dropChance: 0.085 },
  ],
  drops: [],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_bow', 'attack_melee', 'avoid_entity', 'wander', 'look_at_player', 'look_random'],
  avoids: ['zoglin', 'soul_fire'],
  targets: ['player', 'wither_skeleton'],
  spawn: { dimension: DIM_NETHER, biomes: ['nether_wastes', 'crimson_forest', 'bastion_remnant'], light: [0, 11], group: [2, 4], weight: 15 },
  onSpawn(m) { m.barterTicks = 0; m.admiringTicks = 0; m.canPickUpLoot = true; m.crossedArms = false; m.zombifyTicks = 0; },
  onTick(m) {
    // Zombification in the overworld or the end.
    if (m.world.dimension !== DIM_NETHER) {
      if (++m.zombifyTicks > 300) {
        const z = createMob('zombified_piglin', m.world, m.x, m.y, m.z, { baby: m.baby });
        if (z) { z.yaw = m.yaw; m.remove(); return; }
      }
      m.shaking = true;
    } else { m.zombifyTicks = 0; m.shaking = false; }
    if (m.admiringTicks > 0) { m.admiringTicks--; m.crossedArms = true; m.vx *= 0.5; m.vz *= 0.5; return; }
    m.crossedArms = false;
    // Neutral toward gold-armoured players.
    const p = m.nearestPlayer(16);
    if (p && !m.target && m.lastHurtByTicks <= 0 && !wearingGold(p)) { m.setTarget(p); }
    else if (p && m.target === p && wearingGold(p) && m.lastHurtByTicks <= 0) m.setTarget(null);
    // Picks up gold ingots off the floor and barters.
    if (m.barterTicks > 0) { m.barterTicks--; return; }
    const gold = near(m, 8, (e) => e.type === 'item' && e.stack && e.stack.item === 'gold_ingot');
    if (!gold.length) return;
    const it = gold[0];
    m.moveTo(it.x, it.y, it.z, 1.2);
    if (m.distanceTo(it) > 1.4) return;
    it.remove();
    m.admiringTicks = 120;
    m.barterTicks = 140;
    const roll = weightedPick(m.rng, BARTER_LOOT.map((e) => [e, e[1]]));
    dropStack(m.world, m.x, m.y + 1, m.z, mkStack(roll[0], m.rng.range(roll[2], roll[3])));
  },
  onInteract(m, player, stack) {
    if (!stack || stack.item !== 'gold_ingot' || m.baby) return false;
    shrinkHeld(player, stack);
    m.admiringTicks = 120;
    const roll = weightedPick(m.rng, BARTER_LOOT.map((e) => [e, e[1]]));
    dropStack(m.world, m.x, m.y + 1, m.z, mkStack(roll[0], m.rng.range(roll[2], roll[3])));
    return true;
  },
  ranged(m, target) {
    const held = m.equipment.mainhand;
    if (!held || held.item !== 'crossbow' || m.attackCooldown > 0) return;
    m.attackCooldown = 40;
    bowShot(m, target, { type: 'arrow', damage: 3, speed: 2.2 });
  },
  onHurt(m) {
    // Hurting one piglin angers the whole camp.
    for (const o of near(m, 16, (e) => e.type === 'piglin' || e.type === 'piglin_brute')) {
      if (!o.target) { o.setTarget(m.lastHurtBy); o.angerTicks = 600; }
    }
    return true;
  },
});

defineMob('piglin_brute', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.79,
  health: 50, damage: 13, speed: 0.35, xp: 20, followRange: 16,
  model: 'piglin_brute', skin: 'piglin_brute',
  equipment: [{ slot: 'mainhand', item: 'golden_axe', chance: 1, dropChance: 0.085 }],
  drops: [],
  ai: AI_HOSTILE,
  targets: ['player', 'wither_skeleton'],
  spawn: { dimension: DIM_NETHER, biomes: ['bastion_remnant'], light: [0, 15], group: [1, 2], weight: 5, natural: false },
  onSpawn(m) { m.zombifyTicks = 0; },
  onTick(m) {
    if (m.world.dimension === DIM_NETHER) { m.zombifyTicks = 0; return; }
    if (++m.zombifyTicks > 300) {
      const z = createMob('zombified_piglin', m.world, m.x, m.y, m.z, {});
      if (z) m.remove();
    }
  },
});

defineMob('zombified_piglin', {
  category: 'neutral', width: 0.6, height: 1.95, eyeHeight: 1.79,
  health: 20, armor: 2, damage: 5, speed: 0.23, xp: 5, followRange: 16,
  undead: true, fireImmune: true, babyForm: true,
  model: 'zombified_piglin', skin: 'zombified_piglin',
  equipment: [{ slot: 'mainhand', item: 'golden_sword', chance: 1, dropChance: 0.085 }],
  drops: [D('rotten_flesh', 0, 1, 1), D('gold_nugget', 0, 1, 1)],
  rareDrops: [RD('gold_ingot', 0.025)],
  ai: AI_NEUTRAL,
  spawn: { dimension: DIM_NETHER, light: [0, 11], group: [4, 4], weight: 100 },
  onHurt(m) {
    // The whole pack turns on whoever struck one of them.
    m.angerTicks = 400 + m.rng.range(0, 400);
    m.angry = true;
    for (const o of near(m, 32, (e) => e.type === 'zombified_piglin')) {
      o.angerTicks = 400; o.angry = true; o.setTarget(m.lastHurtBy);
    }
    return true;
  },
});

defineMob('hoglin', {
  category: 'hostile', width: 1.4, height: 1.4, eyeHeight: 1.2,
  health: 40, damage: 8, speed: 0.3, xp: 5, followRange: 16, knockbackResist: 0.6,
  babyForm: true, breedItems: ['crimson_fungus'], model: 'hoglin', skin: 'hoglin',
  drops: [D('porkchop', 2, 4, 1), D('leather', 0, 1, 1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'avoid_entity', 'panic', 'breed', 'wander', 'look_at_player', 'look_random'],
  avoids: ['warped_fungus'],
  targets: ['player'],
  spawn: { dimension: DIM_NETHER, biomes: ['crimson_forest'], light: [0, 15], group: [3, 4], weight: 9 },
  onSpawn(m) { m.zombifyTicks = 0; },
  onTick(m) {
    // Repelled by warped fungus, on the floor or in a player's hand.
    const f = findBlockNear(m.world, m.x, m.y, m.z, 8, [bid('warped_fungus'), bid('nether_wart_block')]);
    if (f) {
      const dx = m.x - (f.x + 0.5), dz = m.z - (f.z + 0.5);
      const d = Math.hypot(dx, dz) || 1;
      m.vx += (dx / d) * 0.6; m.vz += (dz / d) * 0.6;
      m.setTarget(null);
    }
    if (m.world.dimension !== DIM_NETHER) {
      m.shaking = true;
      if (++m.zombifyTicks > 300) {
        const z = createMob('zoglin', m.world, m.x, m.y, m.z, { baby: m.baby });
        if (z) m.remove();
      }
    } else { m.zombifyTicks = 0; m.shaking = false; }
  },
  onAttack(m, target) {
    // Hoglins toss their victims into the air.
    // Mob.attack already shoved the victim away; this hook only adds the toss.
    try { target.vy = Math.max(target.vy || 0, 6); } catch { /* optional */ }
  },
});

defineMob('zoglin', {
  category: 'hostile', width: 1.4, height: 1.4, eyeHeight: 1.2,
  health: 40, damage: 8, speed: 0.3, xp: 5, followRange: 16, knockbackResist: 0.6,
  undead: true, babyForm: true, model: 'zoglin', skin: 'zoglin',
  drops: [D('rotten_flesh', 1, 3, 1)],
  ai: AI_HOSTILE,
  targets: ['player', 'villager', 'iron_golem', 'cow', 'pig', 'sheep', 'chicken'],
  spawn: { natural: false, weight: 0 },
  onAttack(m, target) {
    try { target.vy = Math.max(target.vy || 0, 6); } catch { /* optional */ }
  },
});

// ---- witch ----------------------------------------------------------------

const WITCH_THROWS = [
  { potion: 'harming', ticks: 1, level: 0, minDist: 0, weight: 3 },
  { potion: 'slowness', ticks: 1800, level: 0, minDist: 8, weight: 2 },
  { potion: 'weakness', ticks: 1800, level: 0, minDist: 3, weight: 2 },
  { potion: 'poison', ticks: 900, level: 0, minDist: 8, weight: 2 },
];

defineMob('witch', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.62,
  health: 26, damage: 0, speed: 0.25, xp: 5, followRange: 16,
  model: 'witch', skin: 'witch',
  drops: [D('glass_bottle', 0, 2, 1), D('glowstone_dust', 0, 2, 1), D('gunpowder', 0, 2, 1),
    D('redstone', 0, 2, 1), D('spider_eye', 0, 2, 1), D('sugar', 0, 2, 1), D('stick', 0, 2, 1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_ranged', 'wander', 'look_at_player', 'look_random'],
  spawn: { biomes: ['swamp'], light: [0, 7], group: [1, 1], weight: 5 },
  onSpawn(m) { m.drinkTicks = 0; m.throwCooldown = 0; },
  onTick(m) {
    if (m.throwCooldown > 0) m.throwCooldown--;
    if (m.drinkTicks > 0) {
      m.usingItem = true;
      if (--m.drinkTicks > 0) return;
      m.usingItem = false;
      const p = m._drinking;
      m._drinking = null;
      if (p) m.addEffect(p.effect, p.ticks, p.level);
      return;
    }
    // Drinks its own potions when hurt, slowed or on fire.
    if (m.health < m.maxHealth * 0.5 && !m.hasEffect('regeneration')) {
      m._drinking = { effect: 'regeneration', ticks: 800, level: 0 }; m.drinkTicks = 40; return;
    }
    if (m.fireTicks > 0 && !m.hasEffect('fire_resistance')) {
      m._drinking = { effect: 'fire_resistance', ticks: 1600, level: 0 }; m.drinkTicks = 40; return;
    }
    if (m.target && m.distanceTo(m.target) > 10 && !m.hasEffect('speed')) {
      m._drinking = { effect: 'speed', ticks: 1800, level: 0 }; m.drinkTicks = 40; return;
    }
  },
  ranged(m, target) {
    if (m.drinkTicks > 0 || m.throwCooldown > 0) return;
    m.throwCooldown = 60;
    const dist = m.distanceTo(target);
    const choices = WITCH_THROWS.filter((t) => dist >= t.minDist);
    const pick = weightedPick(m.rng, (choices.length ? choices : WITCH_THROWS).map((t) => [t, t.weight]));
    const a = aimAt(m, target, 1.1, 0.25);
    shootProjectile('splash_potion', m.world, m, m.x, m.y + m.eyeHeight - 0.2, m.z, a.dx, a.dy, a.dz,
      { potion: pick.potion, effects: [{ name: pick.potion === 'harming' ? 'instant_damage' : pick.potion, ticks: pick.ticks, level: pick.level }] });
    playAt(m.world, 'witch_throw', m.x, m.y, m.z, 1, 1);
  },
  onHurt(m, amount, source) {
    // Witches shrug off most magic damage.
    if (source && source.magic) return amount * 0.15;
    return true;
  },
});

// ---- ocean hostiles -------------------------------------------------------

/** Guardian laser: 80 ticks of charge, then a hit that ignores line of sight loss. */
function guardianTick(m, elder) {
  swimTick(m, elder ? 0.28 : 0.36);
  m.spikesOut = !m.target || m.hurtTime > 0;
  const t = m.target;
  if (!t || !m.inWater || !m.canSee(t) || m.distanceTo(t) > (elder ? 20 : 15)) {
    m.beamTicks = 0; m.beaming = false; m.beamTarget = null; return;
  }
  m.beamTarget = t;
  m.beaming = true;
  m.faceEntity(t, 0.3);
  m.beamTicks = (m.beamTicks || 0) + 1;
  if (m.beamTicks === 1) playAt(m.world, 'guardian_attack', m.x, m.y, m.z, 1, 1);
  if (m.beamTicks < 80) return;
  m.beamTicks = 0;
  const dmg = (elder ? 8 : 6) * difficultyDamage();
  t.hurt?.(dmg, srcOf('magic', m, m));
  particles('magic', t.x, t.y + 1, t.z, { count: 12, spread: 0.5, color: 0x00b0b0 });
}

defineMob('guardian', {
  category: 'hostile', width: 0.85, height: 0.85, eyeHeight: 0.6,
  health: 30, armor: 6, damage: 6, speed: 0.5, xp: 10, followRange: 16,
  waterMob: true, model: 'guardian', skin: 'guardian',
  drops: [D('prismarine_shard', 0, 2, 1)],
  rareDrops: [RD('prismarine_crystals', 0.4), RD('cod', 0.4)],
  ai: ['swim_wander', 'hurt_by_target', 'nearest_attackable_target', 'guardian_beam', 'look_at_player'],
  targets: ['player', 'squid', 'glow_squid', 'axolotl'],
  spawn: { biomes: ['ocean', 'deep_ocean', 'cold_ocean'], light: [0, 15], y: [30, 62], group: [2, 4], weight: 4, surface: false, block: 'water' },
  onSpawn(m) { m.beamTicks = 0; },
  onTick(m) { guardianTick(m, false); },
  onHurt(m, amount, source) {
    // Thorns: touching a guardian with its spikes out hurts.
    const a = source && source.direct;
    if (m.spikesOut && a && a !== m && !source.projectile) a.hurt?.(2, srcOf('thorns', m, m));
    return true;
  },
});

defineMob('elder_guardian', {
  category: 'hostile', width: 1.99, height: 1.99, eyeHeight: 1.5,
  health: 80, armor: 6, damage: 8, speed: 0.3, xp: 10, followRange: 16,
  waterMob: true, model: 'elder_guardian', skin: 'elder_guardian', scale: 2.35,
  drops: [D('prismarine_shard', 0, 2, 1), D('wet_sponge', 1, 1)],
  rareDrops: [RD('prismarine_crystals', 0.5), RD('cod', 0.5)],
  ai: ['swim_wander', 'hurt_by_target', 'nearest_attackable_target', 'guardian_beam', 'look_at_player'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.beamTicks = 0; m.curseTimer = 1200; m.persistent = true; },
  onTick(m) {
    guardianTick(m, true);
    // Inflicts Mining Fatigue III on every player within 50 blocks.
    if (--m.curseTimer > 0) return;
    m.curseTimer = 1200;
    for (const p of near(m, 50, isTargetablePlayer)) {
      p.addEffect?.('mining_fatigue', 6000, 2);
      particles('magic', p.x, p.y + 1, p.z, { count: 1 });
      playAt(m.world, 'elder_guardian_curse', p.x, p.y, p.z, 1, 1);
    }
  },
  onHurt(m, amount, source) {
    const a = source && source.direct;
    if (m.spikesOut && a && a !== m && !source.projectile) a.hurt?.(2, srcOf('thorns', m, m));
    return true;
  },
});

// ---- shulker --------------------------------------------------------------

defineMob('shulker', {
  category: 'hostile', width: 1, height: 1, eyeHeight: 0.5,
  health: 30, armor: 20, damage: 4, speed: 0, xp: 5, followRange: 16,
  knockbackResist: 1, noGravity: true, model: 'shulker', skin: 'shulker', dyeable: true,
  drops: [D('shulker_shell', 0, 1, 1)],
  ai: ['shulker_peek', 'hurt_by_target', 'nearest_attackable_target', 'look_at_player'],
  spawn: { dimension: DIM_END, light: [0, 15], group: [1, 1], weight: 10, natural: false },
  onSpawn(m) {
    m.gravity = false;
    m.peek = 0; m.attachFace = 1; m.shootCooldown = m.rng.range(20, 40); m.color = null;
    // Latch on to whatever solid block is adjacent.
    const dirs = [[0, -1, 0, 1], [0, 1, 0, 0], [0, 0, -1, 3], [0, 0, 1, 2], [-1, 0, 0, 5], [1, 0, 0, 4]];
    for (const d of dirs) {
      if (m.world.isSolid(Math.floor(m.x) + d[0], Math.floor(m.y) + d[1], Math.floor(m.z) + d[2])) { m.attachFace = d[3]; break; }
    }
  },
  onTick(m) {
    m.gravity = false;
    m.vx = m.vy = m.vz = 0;
    if (m.color) m.skinName = `shulker_${m.color}`;
    const t = m.target || m.nearestPlayer(16);
    // Opens up to fire, closes again when nothing is around.
    const want = t ? 1 : 0;
    m.peek += clamp(want - m.peek, -0.05, 0.05);
    if (!t || m.peek < 0.9) return;
    if (--m.shootCooldown > 0) return;
    m.shootCooldown = m.rng.range(20, 40);
    const a = aimAt(m, t, 0.6, 0);
    shootProjectile('shulker_bullet', m.world, m, m.x, m.y + 0.5, m.z, a.dx, a.dy, a.dz,
      { target: t, damage: 4, homing: true, effects: [{ name: 'levitation', ticks: 200, level: 0 }] });
    playAt(m.world, 'shulker_shoot', m.x, m.y, m.z, 1, 1);
  },
  onHurt(m, amount, source) {
    // A closed shulker takes far less damage from projectiles.
    if (m.peek < 0.3 && source && source.projectile) return amount * 0.25;
    // Teleports away when badly hurt.
    if (m.health - amount < m.maxHealth * 0.5 && m.rng.chance(0.25)) m.teleportRandom(8);
    return true;
  },
});

// ---- phantom --------------------------------------------------------------

defineMob('phantom', {
  category: 'hostile', width: 0.9, height: 0.5, eyeHeight: 0.4,
  health: 20, damage: 2, speed: 0.4, xp: 5, followRange: 64,
  flying: true, burnsInDay: true, undead: true, model: 'phantom', skin: 'phantom',
  drops: [D('phantom_membrane', 0, 1, 1)],
  ai: ['phantom_circle', 'hurt_by_target', 'nearest_attackable_target', 'look_at_player'],
  spawn: { light: [0, 4], y: [63, 127], group: [1, 4], weight: 8, natural: false },
  onSpawn(m) { m.phase = 'circle'; m.circleAngle = m.rng.next() * Math.PI * 2; m.circleR = 12 + m.rng.range(0, 8); m.diveCooldown = 100; },
  onTick(m) {
    m.gravity = false;
    const t = m.target || m.nearestPlayer(64);
    if (!t) {
      m.vy += 0.1; m.vx *= 0.95; m.vz *= 0.95;
      return;
    }
    if (m.phase === 'circle') {
      // Orbits high above its victim before committing to a dive.
      m.circleAngle += 0.05;
      const tx = t.x + Math.cos(m.circleAngle) * m.circleR;
      const tz = t.z + Math.sin(m.circleAngle) * m.circleR;
      const ty = t.y + 12;
      m.vx += clamp(tx - m.x, -1, 1) * 0.9;
      m.vy += clamp(ty - m.y, -1, 1) * 0.7;
      m.vz += clamp(tz - m.z, -1, 1) * 0.9;
      if (--m.diveCooldown <= 0 && m.y > t.y + 6) { m.phase = 'dive'; m.setTarget(t); }
    } else {
      // Straight-line swoop; pulls up after the pass.
      const dx = t.x - m.x, dy = (t.y + 0.5) - m.y, dz = t.z - m.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      m.vx += (dx / d) * 2.2; m.vy += (dy / d) * 2.2; m.vz += (dz / d) * 2.2;
      if (d < 1.6 && m.attackCooldown <= 0) m.attack(t);
      if (m.y < t.y - 1 || d < 1.2) { m.phase = 'circle'; m.diveCooldown = m.rng.range(60, 140); }
    }
    m.vx *= 0.92; m.vy *= 0.92; m.vz *= 0.92;
    m.yaw = Math.atan2(-m.vx, m.vz);
  },
});

// ---- illagers and raids ---------------------------------------------------

defineMob('vex', {
  category: 'hostile', width: 0.4, height: 0.8, eyeHeight: 0.5,
  health: 14, damage: 9, speed: 0.5, xp: 3, followRange: 32,
  flying: true, illager: true, model: 'vex', skin: 'vex',
  equipment: [{ slot: 'mainhand', item: 'iron_sword', chance: 1, dropChance: 0 }],
  drops: [],
  ai: ['fly_wander', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'look_at_player'],
  targets: ['player', 'villager', 'iron_golem'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.lifeTicks = m.rng.range(1200, 1800); m.charging = false; },
  onTick(m) {
    m.gravity = false;
    // Vexes fly straight through walls at their target and expire on a timer.
    const t = m.target;
    if (t) {
      const dx = t.x - m.x, dy = (t.y + 0.6) - m.y, dz = t.z - m.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      m.vx += (dx / d) * 1.2; m.vy += (dy / d) * 1.2; m.vz += (dz / d) * 1.2;
      m.charging = d > 2;
      if (d < 1.4 && m.attackCooldown <= 0) m.attack(t);
    } else { m.vy += 0.14; }
    m.vx *= 0.9; m.vy *= 0.9; m.vz *= 0.9;
    if (--m.lifeTicks <= 0) m.hurt(1, srcOf('magic'));
  },
});

defineMob('evoker', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.62,
  health: 24, damage: 0, speed: 0.5, xp: 10, followRange: 16, illager: true,
  model: 'evoker', skin: 'evoker',
  drops: [D('emerald', 0, 1, 1)],
  rareDrops: [RD('totem_of_undying', 1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_ranged', 'wander', 'look_at_player', 'look_random'],
  targets: ['player', 'villager', 'iron_golem', 'snow_golem'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.spellCooldown = 100; m.casting = 0; m.spell = null; },
  onTick(m) {
    if (m.casting > 0) {
      m.casting--;
      m.vx *= 0.4; m.vz *= 0.4;
      if (m.casting === 0) evokerCast(m);
      return;
    }
    if (m.spellCooldown > 0) { m.spellCooldown--; return; }
    const t = m.target;
    if (!t) return;
    m.spellCooldown = 100;
    m.casting = 20;
    const vexes = near(m, 16, (e) => e.type === 'vex').length;
    m.spell = vexes < 8 && m.rng.chance(0.5) ? 'summon_vex' : 'fangs';
    playAt(m.world, 'evoker_cast', m.x, m.y, m.z, 1, 1);
  },
});

/** Fires whichever spell the evoker just finished channelling. */
function evokerCast(m) {
  const t = m.target;
  if (!t) return;
  if (m.spell === 'summon_vex') {
    for (let i = 0; i < 3; i++) {
      const v = createMob('vex', m.world, m.x + m.rng.range(-2, 2), m.y + 1, m.z + m.rng.range(-2, 2), {});
      if (v) { v.setTarget(t); v.owner = m; }
    }
    return;
  }
  // Two arcs of evoker fangs sweeping toward the target.
  const baseA = Math.atan2(t.z - m.z, t.x - m.x);
  for (let i = 0; i < 8; i++) {
    const d = 1.25 * (i + 1);
    spawnFang(m, m.x + Math.cos(baseA) * d, m.z + Math.sin(baseA) * d, t);
  }
  for (let i = 0; i < 5; i++) {
    const a = baseA + i * Math.PI * 0.4;
    spawnFang(m, m.x + Math.cos(a) * 1.5, m.z + Math.sin(a) * 1.5, t);
  }
}

/** One fang: a delayed 6-damage hit at a ground position. */
function spawnFang(m, x, z, target) {
  const w = m.world;
  let y = Math.floor(m.y);
  while (y > 1 && !w.isSolid(Math.floor(x), y - 1, Math.floor(z))) y--;
  particles('magic', x, y + 0.2, z, { count: 6, spread: 0.3, color: 0x30204a });
  playAt(w, 'evoker_fangs', x, y, z, 1, 1);
  const hits = w.entitiesNear(x, y + 0.5, z, 1.4,
    (e) => e !== m && (isTargetablePlayer(e) || (e.isMob && !(e.def && e.def.illager))));
  for (const e of hits) e.hurt?.(6, srcOf('magic', m, m));
}

defineMob('vindicator', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.62,
  health: 24, damage: 13, speed: 0.35, xp: 5, followRange: 16, illager: true,
  model: 'vindicator', skin: 'vindicator',
  equipment: [{ slot: 'mainhand', item: 'iron_axe', chance: 1, dropChance: 0.085 }],
  drops: [D('emerald', 0, 1, 1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'open_door', 'break_door', 'wander', 'look_at_player', 'look_random'],
  targets: ['player', 'villager', 'iron_golem', 'wandering_trader'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.johnny = m.customName === 'Johnny'; m.crossedArms = true; },
  onTick(m) {
    m.crossedArms = !m.target;
    // "Johnny" vindicators attack everything that moves.
    if (m.customName === 'Johnny' && !m.target) {
      const v = near(m, 16, (e) => e !== m && (e.isMob || isTargetablePlayer(e)));
      if (v.length) m.setTarget(v[0]);
    }
  },
});

defineMob('pillager', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.62,
  health: 24, damage: 3, speed: 0.35, xp: 5, followRange: 32, illager: true,
  model: 'pillager', skin: 'pillager',
  equipment: [{ slot: 'mainhand', item: 'crossbow', chance: 1, dropChance: 0.085 }],
  drops: [], rareDrops: [RD('ominous_bottle', 0.1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_bow', 'wander', 'look_at_player', 'look_random'],
  targets: ['player', 'villager', 'iron_golem', 'wandering_trader'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.reloadTicks = 0; },
  ranged(m, target) {
    if (m.attackCooldown > 0) return;
    m.attackCooldown = 50;                          // crossbow reload
    m.aiming = true;
    bowShot(m, target, { type: 'arrow', damage: 3, speed: 3.15 });
  },
});

defineMob('illusioner', {
  category: 'hostile', width: 0.6, height: 1.95, eyeHeight: 1.62,
  health: 32, damage: 0, speed: 0.5, xp: 5, followRange: 32, illager: true,
  model: 'illusioner', skin: 'illusioner',
  equipment: [{ slot: 'mainhand', item: 'bow', chance: 1, dropChance: 0 }],
  drops: [],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_bow', 'wander', 'look_at_player', 'look_random'],
  targets: ['player', 'villager', 'iron_golem'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.spellCooldown = 60; m.mirrorTicks = 0; },
  onTick(m) {
    if (m.spellCooldown > 0) { m.spellCooldown--; return; }
    const t = m.target;
    if (!t) return;
    m.spellCooldown = 300;
    m.casting = 20;
    if (m.rng.chance(0.5)) {
      // Vanishes and leaves four mirror images behind.
      m.addEffect('invisibility', 400, 0);
      m.mirrorTicks = 60;
      particles('magic', m.x, m.y + 1, m.z, { count: 20, spread: 0.6, color: 0x334781 });
    } else {
      t.addEffect?.('blindness', 400, 0);
      playAt(m.world, 'illusioner_cast', m.x, m.y, m.z, 1, 1);
    }
  },
  ranged(m, target) {
    if (m.attackCooldown > 0) return;
    m.attackCooldown = bowCooldown();
    // Three arrows in quick succession.
    for (let i = 0; i < 3; i++) bowShot(m, target, { type: 'arrow', damage: 3.5 });
  },
});

defineMob('ravager', {
  category: 'hostile', width: 1.95, height: 2.2, eyeHeight: 1.9,
  health: 100, armor: 8, damage: 12, speed: 0.3, xp: 20, followRange: 32,
  knockbackResist: 0.75, illager: true, model: 'ravager', skin: 'ravager',
  drops: [D('saddle', 1, 1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'ravager_charge', 'attack_melee', 'wander', 'look_at_player'],
  targets: ['player', 'villager', 'iron_golem', 'wandering_trader'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.roarCooldown = 0; m.stunTicks = 0; m.chargeTicks = 0; },
  onTick(m) {
    if (m.stunTicks > 0) { m.stunTicks--; m.vx *= 0.2; m.vz *= 0.2; m.roaring = m.stunTicks > 20; return; }
    const t = m.target;
    if (!t) { m.ramming = false; return; }
    // Charges in a straight line, then roars and flings everything nearby.
    if (m.chargeTicks > 0) {
      m.chargeTicks--;
      m.ramming = true;
      const dx = t.x - m.x, dz = t.z - m.z, d = Math.hypot(dx, dz) || 1;
      m.vx += (dx / d) * 1.4; m.vz += (dz / d) * 1.4;
      if (d < 2) {
        m.chargeTicks = 0;
        m.ramming = false;
        m.roaring = true;
        m.roarCooldown = 60;
        for (const e of near(m, 4, (x) => x !== m && !(x.def && x.def.illager))) {
          const kbSrc = srcOf('mob', m, m); kbSrc.knockback = 2.2;
          e.hurt?.(6 * difficultyDamage(), kbSrc);
          try { e.vy = Math.max(e.vy || 0, 6); } catch { /* optional */ }
        }
      }
      return;
    }
    m.roaring = false;
    if (m.roarCooldown > 0) { m.roarCooldown--; return; }
    if (m.distanceTo(t) > 4 && m.rng.chance(0.05)) m.chargeTicks = 40;
    // Griefing: ravagers trample crops and smash leaves.
    if (!griefingAllowed(m.world)) return;
    if ((m.age & 7) !== 0) return;
    const x = Math.floor(m.x), y = Math.floor(m.y + 0.5), z = Math.floor(m.z);
    const id = m.world.getBlock(x, y, z);
    const def = getBlock(id);
    if (def && (def.name.endsWith('_leaves') || def.model === 'crop')) m.world.setBlock(x, y, z, 0, 0);
  },
  onHurt(m, amount, source) {
    // A shield block stuns the ravager.
    const a = source && source.direct;
    if (a && a.blocking) { m.stunTicks = 40; return 0; }
    return true;
  },
});

// ---- deep dark and 1.21 additions ----------------------------------------

defineMob('warden', {
  category: 'hostile', width: 0.9, height: 2.9, eyeHeight: 2.4,
  health: 500, armor: 0, damage: 30, speed: 0.3, xp: 5, followRange: 32,
  knockbackResist: 1, model: 'warden', skin: 'warden',
  drops: [D('sculk_catalyst', 1, 1)],
  ai: ['warden_sniff', 'hurt_by_target', 'nearest_attackable_target', 'attack_melee', 'wander'],
  spawn: { biomes: ['deep_dark'], light: [0, 15], y: [0, 40], group: [1, 1], weight: 0, natural: false },
  onSpawn(m) {
    m.persistent = true;
    m.anger = Object.create(null);      // entity id -> anger level
    m.sniffing = false;
    m.emergeTicks = 130;
    m.sonicCooldown = 0;
    m.digTicks = 0;
    m.invulnerable = true;
  },
  onTick(m) {
    // Emerging from the ground: invulnerable and immobile.
    if (m.emergeTicks > 0) {
      m.invulnerable = true;
      m.vx = m.vz = 0;
      if (--m.emergeTicks <= 0) m.invulnerable = false;
      return;
    }
    // The warden is blind; it navigates by vibration. Anything that moves
    // fast, gets hit or makes noise nearby raises its anger.
    if ((m.age & 3) === 0) {
      for (const e of near(m, 24, (e) => e !== m && (isTargetablePlayer(e) || e.isMob))) {
        const speed = Math.hypot(e.vx || 0, e.vz || 0);
        if (speed < 1.5 && !(e.sprinting || e.swinging)) continue;
        const id = e.id;
        m.anger[id] = (m.anger[id] || 0) + (e.sprinting ? 10 : 5);
        m.sniffing = true;
        if (m.anger[id] > 40 && (!m.target || (m.anger[m.target.id] || 0) < m.anger[id])) m.setTarget(e);
      }
    }
    // Anger decays; when it runs out the warden burrows away.
    if ((m.age % 20) === 0) {
      let max = 0;
      for (const k in m.anger) { m.anger[k] = Math.max(0, m.anger[k] - 1); if (m.anger[k] > max) max = m.anger[k]; }
      if (max <= 0 && !m.target) {
        if (++m.digTicks > 60) { m.digging = true; m.remove(); }
      } else m.digTicks = 0;
    }
    // Darkness aura.
    if ((m.age % 40) === 0) {
      for (const p of near(m, 20, isTargetablePlayer)) p.addEffect?.('darkness', 260, 0);
    }
    const t = m.target;
    if (!t) return;
    m.faceEntity(t, 0.3);
    if (m.sonicCooldown > 0) { m.sonicCooldown--; return; }
    const d = m.distanceTo(t);
    // Sonic boom: long range, pierces armour and shields.
    if (d > 5 && d < 20 && m.canSee(t)) {
      m.sonicCooldown = 40;
      m.roaring = true;
      playAt(m.world, 'warden_sonic_boom', m.x, m.y, m.z, 3, 1);
      const dx = t.x - m.x, dy = (t.y + 1) - (m.y + m.eyeHeight), dz = t.z - m.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      for (let i = 1; i < len; i++) {
        particles('magic', m.x + dx / len * i, m.y + m.eyeHeight + dy / len * i, m.z + dz / len * i, { count: 1 });
      }
      const src = srcOf('sonic_boom', m, m);
      src.bypassArmor = true;
      src.knockback = 0.5;
      t.hurt?.(10, src);
      try { t.vy = Math.max(t.vy || 0, 3); } catch { /* optional */ }
    }
  },
  onHurt(m, amount, source) {
    const a = source && (source.entity || source.direct);
    if (a) m.anger[a.id] = (m.anger[a.id] || 0) + 35;
    // Ranged attacks barely scratch it.
    if (source && source.projectile) return amount * 0.25;
    return true;
  },
});

defineMob('breeze', {
  category: 'hostile', width: 0.6, height: 1.77, eyeHeight: 1.5,
  health: 30, damage: 0, speed: 0.4, xp: 10, followRange: 24,
  model: 'breeze', skin: 'breeze', immuneToFall: true,
  drops: [D('breeze_rod', 1, 2, 1)],
  ai: ['float', 'hurt_by_target', 'nearest_attackable_target', 'attack_ranged', 'wander', 'look_at_player'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) { m.hopCooldown = 0; },
  onTick(m) {
    // Bounces around its target rather than walking at it.
    const t = m.target;
    if (!t) return;
    if (m.hopCooldown > 0) { m.hopCooldown--; return; }
    if (!m.onGround) return;
    m.hopCooldown = m.rng.range(20, 40);
    const a = m.rng.next() * Math.PI * 2;
    const d = m.distanceTo(t);
    const towards = d > 8;
    const dx = towards ? (t.x - m.x) : Math.cos(a) * 5;
    const dz = towards ? (t.z - m.z) : Math.sin(a) * 5;
    const len = Math.hypot(dx, dz) || 1;
    m.vx = (dx / len) * 7; m.vz = (dz / len) * 7; m.vy = 8;
    particles('cloud', m.x, m.y, m.z, { count: 8, spread: 0.5 });
  },
  ranged(m, target) {
    if (m.attackCooldown > 0) return;
    m.attackCooldown = 60;
    const a = aimAt(m, target, 0.7, 0.05);
    const shot = shootProjectile('wind_charge', m.world, m, m.x, m.y + m.eyeHeight, m.z, a.dx, a.dy, a.dz,
      { damage: 1, knockback: 1.8 });
    if (!shot) {
      // No wind charge entity available: apply the burst directly.
      const kbSrc = srcOf('magic', m, m); kbSrc.knockback = 1.8;
      target.hurt?.(1, kbSrc);
      try { target.vy = Math.max(target.vy || 0, 6); } catch { /* optional */ }
      particles('cloud', target.x, target.y + 1, target.z, { count: 12, spread: 0.8 });
    }
    playAt(m.world, 'breeze_shoot', m.x, m.y, m.z, 1, 1);
  },
  onHurt(m, amount, source) {
    // Wind charges and arrows blow right past a breeze.
    if (source && source.projectile) return 0;
    return true;
  },
});

defineMob('creaking', {
  category: 'hostile', width: 0.9, height: 2.7, eyeHeight: 2.4,
  health: 1, damage: 3, speed: 0.4, xp: 0, followRange: 32,
  knockbackResist: 1, model: 'creaking', skin: 'creaking',
  drops: [], rareDrops: [],
  ai: ['hurt_by_target', 'nearest_attackable_target', 'attack_melee'],
  spawn: { biomes: ['pale_garden', 'dark_forest'], light: [0, 7], group: [1, 1], weight: 0, natural: false },
  onSpawn(m) { m.invulnerable = true; m.heartPos = null; m.frozen = false; },
  onTick(m) {
    // Freezes solid whenever a player is looking at it, and can only be
    // destroyed by breaking its creaking heart.
    let watched = false;
    for (const p of near(m, 32, isTargetablePlayer)) {
      if (looksAtLoosely(p, m)) { watched = true; break; }
    }
    m.watched = watched;
    m.frozen = watched;
    if (watched) { m.vx = 0; m.vz = 0; return; }
    if (m.world.isDay && m.world.isDay()) { m.remove(); return; }
    // The heart keeps it alive.
    if (!m.heartPos) m.heartPos = findBlockNear(m.world, m.x, m.y, m.z, 16, [bid('creaking_heart')]);
    if (m.heartPos && m.world.getBlock(m.heartPos.x, m.heartPos.y, m.heartPos.z) !== bid('creaking_heart')) {
      m.invulnerable = false;
      m.hurt(10, srcOf('generic'));
    }
  },
  onHurt(m, amount, source) {
    // Damage is redirected to the heart as particles; the body never dies.
    if (m.invulnerable) {
      particles('crit', m.x, m.y + 1.5, m.z, { count: 6, spread: 0.4 });
      if (m.heartPos) particles('crit', m.heartPos.x + 0.5, m.heartPos.y + 0.5, m.heartPos.z + 0.5, { count: 6 });
      return false;
    }
    return true;
  },
});

/** A looser version of looksAt used by the creaking (a ~30 degree cone). */
function looksAtLoosely(viewer, mob) {
  const dx = mob.x - viewer.x;
  const dy = (mob.y + mob.height * 0.6) - (viewer.y + (viewer.eyeHeight || 1.62));
  const dz = mob.z - viewer.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 0.001) return true;
  const lx = -Math.sin(viewer.yaw) * Math.cos(viewer.pitch);
  const ly = -Math.sin(viewer.pitch);
  const lz = Math.cos(viewer.yaw) * Math.cos(viewer.pitch);
  return (dx * lx + dy * ly + dz * lz) / len > 0.86 && mob.canSee(viewer);
}

// ===========================================================================
// Bosses
// ===========================================================================

/**
 * The dragon's flight graph: an outer ring it circles and an inner ring it
 * uses when approaching the fountain, exactly the shape vanilla uses.
 */
function buildDragonNodes() {
  const nodes = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    nodes.push({ x: Math.cos(a) * 62, y: 82 + Math.sin(a * 3) * 6, z: Math.sin(a) * 62, ring: 0 });
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    nodes.push({ x: Math.cos(a) * 26, y: 76, z: Math.sin(a) * 26, ring: 1 });
  }
  return nodes;
}

defineMob('ender_dragon', {
  category: 'boss', boss: true, bossName: 'Ender Dragon', bossColor: 0xc030ff,
  width: 16, height: 8, eyeHeight: 4,
  health: 200, armor: 0, damage: 10, speed: 0.6, xp: 500, followRange: 128,
  knockbackResist: 1, noGravity: true, fireImmune: true, model: 'ender_dragon', skin: 'ender_dragon',
  drops: [],
  ai: ['boss_dragon'],
  spawn: { dimension: DIM_END, natural: false, weight: 0 },
  onSpawn(m) {
    m.persistent = true;
    m.gravity = false;
    m.nodes = buildDragonNodes();
    m.nodeIndex = 0;
    m.phase = 'circling';
    m.phaseTicks = 0;
    m.perchCooldown = 300;
    m.breathTicks = 0;
    m.crystalBeam = null;
    m.deathTicks = 0;
    m.invulnerable = false;
  },
  onTick(m) {
    const w = m.world;
    m.gravity = false;
    if (m.health <= 0) return;

    // --- healed by the end crystals on the obsidian pillars ---------------
    if ((m.age & 15) === 0) {
      const crystals = w.entitiesNear(0, 70, 0, 96, (e) => e.type === 'end_crystal' && !e.removed);
      m.crystalBeam = crystals.length ? crystals[0] : null;
      if (crystals.length && m.health < m.maxHealth) m.heal(1);
    }

    // --- phase machine ---------------------------------------------------
    m.phaseTicks++;
    if (m.phase === 'circling') {
      const n = m.nodes[m.nodeIndex];
      flyToward(m, n.x, n.y, n.z, 1.0);
      if (m.distanceToSq(n.x, n.y, n.z) < 100) m.nodeIndex = (m.nodeIndex + 1) % 12;
      if (--m.perchCooldown <= 0 && !m.crystalBeam) { m.phase = 'approach'; m.phaseTicks = 0; m.nodeIndex = 12; }
      // Strafing run: a dragon fireball at a distant player.
      const p = w.nearestPlayer ? w.nearestPlayer(m.x, m.y, m.z, 128) : null;
      if (p && m.phaseTicks % 200 === 0) {
        const a = aimAt(m, p, 1.0, 0);
        shootProjectile('dragon_fireball', w, m, m.x, m.y - 1, m.z, a.dx, a.dy, a.dz, { damage: 6 });
        playAt(w, 'dragon_growl', m.x, m.y, m.z, 5, 1);
      }
    } else if (m.phase === 'approach') {
      const n = m.nodes[m.nodeIndex];
      flyToward(m, n.x, n.y, n.z, 1.1);
      if (m.distanceToSq(n.x, n.y, n.z) < 64) m.nodeIndex = 12 + (((m.nodeIndex - 12) + 1) % 8);
      if (m.phaseTicks > 200) { m.phase = 'perching'; m.phaseTicks = 0; }
    } else if (m.phase === 'perching') {
      flyToward(m, 0, 70, 0, 0.9);
      if (m.distanceToSq(0, 70, 0) < 36) { m.phase = 'perched'; m.phaseTicks = 0; m.breathTicks = 100; }
      if (m.phaseTicks > 300) { m.phase = 'circling'; m.perchCooldown = 400; }
    } else if (m.phase === 'perched') {
      m.vx *= 0.6; m.vy *= 0.6; m.vz *= 0.6;
      m.perched = true;
      // Breath attack: a pool of lingering dragon's breath.
      if (--m.breathTicks <= 0) {
        m.breathTicks = 60;
        const p = w.nearestPlayer ? w.nearestPlayer(m.x, m.y, m.z, 24) : null;
        if (p) {
          const a = aimAt(m, p, 0.8, 0);
          shootProjectile('dragon_fireball', w, m, m.x, m.y - 1, m.z, a.dx, a.dy, a.dz, { damage: 3, breath: true });
          for (const e of near(m, 8, isTargetablePlayer)) {
            e.hurt?.(3, srcOf('magic', m, m));
            particles('magic', e.x, e.y, e.z, { count: 8, spread: 0.8, color: 0xb060ff });
          }
        }
      }
      if (m.phaseTicks > 400) { m.phase = 'circling'; m.perched = false; m.perchCooldown = 600; m.nodeIndex = 0; }
    }

    // --- body damage: anything the dragon flies through gets swatted ------
    if ((m.age & 3) === 0) {
      for (const e of near(m, 8, (e) => e !== m && (isTargetablePlayer(e) || e.isMob))) {
        const kbSrc = srcOf('mob', m, m); kbSrc.knockback = 2.5;
        e.hurt?.(m.getAttackDamage(), kbSrc);
        try { e.vy = Math.max(e.vy || 0, 8); } catch { /* optional */ }
      }
    }
    // Destroys blocks it flies through, apart from the indestructible ones.
    if ((m.age & 7) === 0 && griefingAllowed(m.world)) {
      const cx = Math.floor(m.x), cy = Math.floor(m.y), cz = Math.floor(m.z);
      for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) {
        const id = w.getBlock(cx + dx, cy + dy, cz + dz);
        if (!id) continue;
        const def = getBlock(id);
        if (def.hardness < 0 || def.name === 'obsidian' || def.name === 'end_stone' ||
          def.name === 'bedrock' || def.name.indexOf('end_portal') === 0) continue;
        w.setBlock(cx + dx, cy + dy, cz + dz, 0, 0);
      }
    }
  },
  onHurt(m, amount, source) {
    // Only the head takes damage while perched; crystals must go first.
    if (m.crystalBeam) return amount * 0.2;
    return true;
  },
  onDeath(m) {
    const w = m.world;
    // The death spiral, the exit portal and 12000 experience.
    for (let i = 0; i < 40; i++) {
      particles('explosion', m.x + (m.rng.next() - 0.5) * 8, m.y + m.rng.next() * 4, m.z + (m.rng.next() - 0.5) * 8, { count: 1 });
    }
    dropXp(w, 0, 72, 0, 12000);
    const frame = bid('end_portal_frame') || bid('bedrock');
    const portal = bid('end_portal');
    if (!frame) return;
    // Small bedrock fountain with the portal in the middle.
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
      w.setBlock(dx, 64, dz, bid('bedrock'), 0);
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && portal) w.setBlock(dx, 65, dz, portal, 0);
    }
    w.setBlock(0, 65, 0, bid('dragon_egg') || 0, 0);
    Game.emit('achievement', 'free_the_end', 'Free the End');
  },
});

/** Steers a flying boss toward a point with smooth turning. */
function flyToward(m, x, y, z, speed) {
  const dx = x - m.x, dy = y - m.y, dz = z - m.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  m.vx += (dx / d) * speed;
  m.vy += (dy / d) * speed * 0.7;
  m.vz += (dz / d) * speed;
  const sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy + m.vz * m.vz);
  const max = 14 * speed;
  if (sp > max) { const f = max / sp; m.vx *= f; m.vy *= f; m.vz *= f; }
  m.yaw = Math.atan2(-m.vx, m.vz);
  m.pitch = -Math.atan2(m.vy, Math.hypot(m.vx, m.vz));
  m.headYaw = m.yaw;
}

defineMob('wither', {
  category: 'boss', boss: true, bossName: 'Wither', bossColor: 0x2b2b2b,
  width: 0.9, height: 3.5, eyeHeight: 3.0,
  health: 300, armor: 4, damage: 8, speed: 0.6, xp: 50, followRange: 40,
  knockbackResist: 1, noGravity: true, fireImmune: true, undead: false,
  model: 'wither', skin: 'wither',
  drops: [D('nether_star', 1, 1)],
  ai: ['boss_wither'],
  spawn: { natural: false, weight: 0 },
  onSpawn(m) {
    m.persistent = true;
    m.gravity = false;
    m.invulTicks = 220;                 // spawn animation
    m.invulnerable = true;
    m.headTargets = [null, null, null];
    m.headCooldowns = [0, 0, 0];
    m.shielded = false;
    m.chargeCooldown = 0;
    m.health = m.maxHealth * (1 / 3);   // vanilla starts the wither at 100 HP
  },
  onTick(m) {
    const w = m.world;
    m.gravity = false;
    m.invulTicks = m.invulTicks | 0;

    // --- spawn animation --------------------------------------------------
    if (m.invulTicks > 0) {
      m.invulnerable = true;
      m.vx = m.vy = m.vz = 0;
      m.y += 0.005;
      m.yaw += 0.15;
      particles('smoke', m.x, m.y + 3, m.z, { count: 3, spread: 0.6, color: 0x1a1a1a });
      if (--m.invulTicks <= 0) {
        m.invulnerable = false;
        m.health = m.maxHealth;
        explodeAt(w, m.x, m.y + 1.5, m.z, 7, { fire: false, breakBlocks: griefingAllowed(m.world), source: m });
        playAt(w, 'wither_spawn', m.x, m.y, m.z, 5, 1);
      } else if (m.invulTicks % 10 === 0) {
        m.heal(1);
      }
      return;
    }

    // --- half health: shielded, charging phase -----------------------------
    const wasShielded = m.shielded;
    m.shielded = m.health <= m.maxHealth * 0.5;
    if (m.shielded && !wasShielded) playAt(w, 'wither_shoot', m.x, m.y, m.z, 4, 0.7);
    if (m.shielded && (m.age & 31) === 0) m.heal(1);

    // --- flight ------------------------------------------------------------
    const t = m.target || m.nearestPlayer(40);
    if (t) {
      m.setTarget(t);
      const wantY = t.y + (m.shielded ? 1 : 6);
      if (m.shielded && m.chargeCooldown <= 0) {
        flyToward(m, t.x, t.y + 1, t.z, 1.4);
        if (m.distanceTo(t) < 3) {
          for (const e of near(m, 3.5, (e) => e !== m && (isTargetablePlayer(e) || e.isMob))) {
            const kbSrc = srcOf('mob', m, m); kbSrc.knockback = 2;
            e.hurt?.(m.getAttackDamage(), kbSrc);
            try { e.vy = Math.max(e.vy || 0, 7); } catch { /* optional */ }
          }
          m.chargeCooldown = 40;
        }
      } else {
        if (m.chargeCooldown > 0) m.chargeCooldown--;
        flyToward(m, t.x, wantY, t.z, 0.7);
      }
    } else {
      m.vx *= 0.9; m.vy *= 0.9; m.vz *= 0.9;
      m.vy += 0.1;
    }

    // --- three heads --------------------------------------------------------
    const candidates = near(m, 40, (e) => e !== m && (isTargetablePlayer(e) || (e.isMob && !e.def.undead && e.def.category !== 'boss')));
    m.headTargets[0] = t || null;
    for (let h = 1; h < 3; h++) {
      const cur = m.headTargets[h];
      if (!cur || cur.removed || cur.dead || m.distanceTo(cur) > 40 || m.rng.chance(0.005)) {
        m.headTargets[h] = candidates.length ? candidates[m.rng.int(candidates.length)] : null;
      }
    }
    for (let h = 0; h < 3; h++) {
      if (m.headCooldowns[h] > 0) { m.headCooldowns[h]--; continue; }
      const ht = m.headTargets[h];
      if (!ht || ht.removed) continue;
      m.headCooldowns[h] = h === 0 ? (Game.difficulty === DIFFICULTY.HARD ? 15 : 20) : m.rng.range(40, 80);
      const ox = (h - 1) * 1.0;
      const a = aimAt(m, ht, 1.2, 0.03);
      shootProjectile('wither_skull', w, m, m.x + ox, m.y + 2.6, m.z, a.dx, a.dy, a.dz, {
        damage: 8, blue: h !== 0 && m.rng.chance(0.001), effects: [{ name: 'wither', ticks: 200, level: 1 }],
      });
      playAt(w, 'wither_shoot', m.x, m.y, m.z, 2, 1);
    }

    // --- griefing -----------------------------------------------------------
    if ((m.age & 15) === 0 && griefingAllowed(m.world) && !m.shielded) {
      const cx = Math.floor(m.x), cy = Math.floor(m.y), cz = Math.floor(m.z);
      for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 3; dy++) for (let dz = -1; dz <= 1; dz++) {
        const id = w.getBlock(cx + dx, cy + dy, cz + dz);
        if (!id) continue;
        const def = getBlock(id);
        if (def.hardness < 0 || def.name === 'bedrock' || def.name === 'obsidian') continue;
        w.setBlock(cx + dx, cy + dy, cz + dz, 0, 0);
      }
    }
  },
  onAttack(m, target) {
    const secs = Game.difficulty === DIFFICULTY.HARD ? 40 : 10;
    target.addEffect?.('wither', secs * 20, 1);
  },
  onHurt(m, amount, source) {
    if (m.invulTicks > 0) return false;
    // Immune to drowning and arrows while shielded; undead cannot hurt it.
    const a = source && (source.entity || source.direct);
    if (a && a.def && a.def.undead) return false;
    if (source && (source.type === 'drown' || source.type === 'void_free')) return false;
    if (m.shielded && source && source.projectile) return false;
    return true;
  },
  onDeath(m) {
    dropXp(m.world, m.x, m.y, m.z, 50);
    explodeAt(m.world, m.x, m.y + 1, m.z, 4, { fire: false, breakBlocks: false, source: m });
    Game.emit('achievement', 'wither_slain', 'Withering Heights');
  },
});

// ===========================================================================
// Factory and queries
// ===========================================================================

/**
 * Creates a mob and (unless `opts.addToWorld === false`) puts it in the world.
 * @param {string} name registry name, e.g. 'zombie'
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z
 * @param {object} [opts] baby, variant, persistent, tamed, owner, slimeSize, health, ...
 * @returns {Mob|null} null when the name is unknown
 */
export function createMob(name, world, x, y, z, opts = {}) {
  const def = MOBS[name];
  if (!def) { console.warn('[mobs] unknown mob: ' + name); return null; }
  if (!world) return null;
  let mob;
  try {
    mob = new Mob(world, x, y, z, def, opts || {});
  } catch (e) {
    console.error('[mobs] could not create ' + name, e);
    return null;
  }
  if (opts && opts.yaw !== undefined) { mob.yaw = opts.yaw; mob.headYaw = opts.yaw; }
  if (opts && opts.addToWorld === false) return mob;
  try {
    if (!world.entitiesById || !world.entitiesById.has(mob.id)) world.addEntity(mob);
  } catch (e) { console.error('[mobs] addEntity failed', e); }
  return mob;
}

/** Alias matching the naming used by /summon and spawn eggs. */
export function spawnMob(name, world, x, y, z, opts = {}) {
  return createMob(name, world, x, y, z, opts);
}

/**
 * The spawn table for one biome and category.
 * @param {string|object} biomeName biome registry name, id or definition
 * @param {string|null} [category] 'passive' | 'hostile' | 'water' | 'ambient';
 *        null returns every category merged together
 * @returns {Array<{name:string, def:object, weight:number, min:number, max:number, category:string}>}
 */
export function mobsForBiome(biomeName, category = null) {
  let biome = null;
  if (typeof biomeName === 'string') biome = biomeByName(biomeName);
  else if (typeof biomeName === 'number') biome = BIOMES[biomeName];
  else if (biomeName && biomeName.name) biome = biomeName;
  const cats = category ? [category] : ['passive', 'hostile', 'water', 'ambient'];
  const out = [];
  const seen = new Set();
  const dim = biome ? biome.dimension : DIM_OVERWORLD;

  // 1. Whatever the biome itself declares.
  if (biome) {
    for (const cat of cats) {
      const list = biome.mobs && biome.mobs[cat];
      if (!list) continue;
      for (const entry of list) {
        const name = Array.isArray(entry) ? entry[0] : (entry.mob || entry.name || entry);
        const weight = Array.isArray(entry) ? entry[1] : (entry.weight ?? 10);
        const def = MOBS[name];
        if (!def || weight <= 0 || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, def, weight, min: def.spawn.group[0], max: def.spawn.group[1], category: cat });
      }
    }
  }

  // 2. Mobs that name this biome (or accept any biome in this dimension)
  //    in their own spawn rules; this is what fills the nether and the end.
  for (let i = 0; i < MOB_NAMES.length; i++) {
    const name = MOB_NAMES[i];
    if (seen.has(name)) continue;
    const def = MOBS[name];
    const sp = def.spawn;
    if (!sp.natural || sp.weight <= 0) continue;
    if (sp.dimension !== dim) continue;
    const cat = def.category === 'neutral' ? 'passive' : def.category;
    if (cats.indexOf(cat) < 0) continue;
    if (sp.biomes) {
      if (!biome || sp.biomes.indexOf(biome.name) < 0) continue;
    } else if (dim === DIM_OVERWORLD && biome && biome.mobs && biome.mobs[cat] && biome.mobs[cat].length) {
      // The biome has its own table for this category; do not add strays to it.
      continue;
    }
    seen.add(name);
    out.push({ name, def, weight: sp.weight, min: sp.group[0], max: sp.group[1], category: cat });
  }
  return out;
}

/**
 * Spawn egg item name for a mob, or null when that mob has no egg.
 * @param {string} mobName
 */
export function spawnEggFor(mobName) {
  if (!mobName) return null;
  const egg = `${mobName}_spawn_egg`;
  return itemExists(egg) ? egg : null;
}

/** Every registered boss, in registration order. */
export const BOSS_MOBS = Object.freeze(MOB_NAMES.filter((n) => MOBS[n].boss));

/** Names grouped by category, handy for the creative menu and /summon. */
export const MOBS_BY_CATEGORY = Object.freeze({
  passive: MOB_NAMES.filter((n) => MOBS[n].category === 'passive'),
  neutral: MOB_NAMES.filter((n) => MOBS[n].category === 'neutral'),
  hostile: MOB_NAMES.filter((n) => MOBS[n].category === 'hostile'),
  ambient: MOB_NAMES.filter((n) => MOBS[n].category === 'ambient'),
  water: MOB_NAMES.filter((n) => MOBS[n].category === 'water'),
  boss: MOB_NAMES.filter((n) => MOBS[n].category === 'boss'),
});

/** Total number of registered mobs. */
export const MOB_COUNT = MOB_NAMES.length;

export default MOBS;
