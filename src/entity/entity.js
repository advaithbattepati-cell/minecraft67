// ============================================================================
// entity.js - The base Entity and LivingEntity.
//
// Everything that exists in the world and is not a block lives on top of these
// two classes: the player, mobs, arrows, boats, dropped items, TNT.
//
// Units: positions are in blocks, velocities in **blocks per second**, and
// durations in ticks (20 per second). `update(dt)` runs once per rendered
// frame and owns physics + interpolation bookkeeping; `tick()` runs exactly 20
// times a second and owns discrete game logic (effects, fire, breath, portals).
// world.tick() calls tick(); main.js calls update() (or tickEntityList).
//
// The swept-AABB `move()` below is the whole game feel, so it follows vanilla's
// shape closely: gather every block box in the swept region, clip Y then X then
// Z independently, then retry the horizontal part raised by `stepHeight`.
// ============================================================================
import {
  GRAVITY, TERMINAL_VELOCITY, WORLD_HEIGHT, MAX_AIR, MAX_HEALTH,
  TICKS_PER_SECOND, ID_MASK, ARMOR_HEAD, ARMOR_CHEST, ARMOR_LEGS, ARMOR_FEET,
  DIM_OVERWORLD, DIM_NETHER, DIM_END, NETHER_SCALE, SEA_LEVEL,
} from '../core/constants.js';
import { AABB, clamp, angleDiff, prettyName } from '../core/util.js';
import { Game } from '../core/game.js';
import { getBlock, blockByName } from '../world/blocks.js';
import { blockBoxes } from '../render/mesher.js';
import {
  tickEffects, triggerDeathEffects, addEffect as fxAddEffect,
  removeEffect as fxRemoveEffect, clearEffects as fxClearEffects,
  serializeEffects, deserializeEffects, damageMultiplier, knockbackResistance,
  fallDamageReduction, swimSpeedMultiplier,
} from '../item/effects.js';
import { getItem } from '../item/items.js';
import {
  getEnchant, damageReduction, depthStriderFactor, respirationBonusTicks,
  thornsDamage, lootingLevel,
} from '../item/enchanting.js';

// ---------------------------------------------------------------------------
// Lazily resolved sibling modules.
//
// loot.js and itementity.js both sit *above* this file in the dependency graph
// (itementity extends Entity), so importing them statically would be a cycle.
// ---------------------------------------------------------------------------
let _loot = null;
let _itementity = null;
let _depsStarted = false;

function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, assign) => {
    try { import(path).then(assign).catch(() => { /* optional */ }); } catch { /* no dynamic import */ }
  };
  grab('../item/loot.js', (m) => { _loot = m; });
  grab('./itementity.js', (m) => { _itementity = m; });
}
loadDeps();

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Horizontal velocity retained per tick while airborne. */
const AIR_FRICTION = 0.91;
/** Vertical velocity retained per tick while airborne (air resistance). */
const AIR_FRICTION_Y = 0.98;
/** Base ground friction; multiplied by the slipperiness of the block below. */
const GROUND_FRICTION = 0.91;
/** Per-tick velocity multiplier while swimming. */
const WATER_DRAG = 0.8;
/** Per-tick velocity multiplier while in lava. Lava is thick. */
const LAVA_DRAG = 0.5;
/** Climbing speed on ladders, vines and scaffolding, blocks per second. */
const CLIMB_SPEED = 2.35;
/** Ticks standing in a nether portal before the dimension swap fires. */
const PORTAL_TRIGGER_TICKS = 80;
/** Ticks of immunity after a portal trip, so you do not bounce straight back. */
const PORTAL_COOLDOWN_TICKS = 300;
/** Largest movement resolved in one collision pass; longer moves sub-step. */
const MAX_MOVE_STEP = 0.4;
/** Hard cap on collision sub-steps, so a teleport cannot stall a frame. */
const MAX_SUBSTEPS = 24;
/** Numerical slack used everywhere in the collision maths. */
const EPS = 1e-7;
/** Ticks of invulnerability after taking a hit. */
const HURT_RESISTANT_TICKS = 10;

/** Equipment slot indices used by LivingEntity.equipment. */
const EQ_HEAD = ARMOR_HEAD, EQ_CHEST = ARMOR_CHEST, EQ_LEGS = ARMOR_LEGS, EQ_FEET = ARMOR_FEET;
const EQ_MAINHAND = 4, EQ_OFFHAND = 5;

// ---------------------------------------------------------------------------
// Block ids we care about by name. blocks.js is a static import, so its
// registry is fully built before this module body runs.
// ---------------------------------------------------------------------------
const idOf = (name) => { const d = blockByName(name); return d ? d.id : -1; };

const ID_COBWEB = idOf('cobweb');
const ID_SLIME_BLOCK = idOf('slime_block');
const ID_HONEY_BLOCK = idOf('honey_block');
const ID_HAY_BLOCK = idOf('hay_block');
const ID_SOUL_SAND = idOf('soul_sand');
const ID_MAGMA_BLOCK = idOf('magma_block');
const ID_NETHER_PORTAL = idOf('nether_portal');
const ID_END_PORTAL = idOf('end_portal');
const ID_END_GATEWAY = idOf('end_gateway');
const ID_POWDER_SNOW = idOf('powder_snow');
const ID_CACTUS = idOf('cactus');
const ID_SWEET_BERRY_BUSH = idOf('sweet_berry_bush');
const ID_WITHER_ROSE = idOf('wither_rose');
const ID_FIRE = idOf('fire');
const ID_SOUL_FIRE = idOf('soul_fire');
const ID_CAMPFIRE = idOf('campfire');
const ID_SOUL_CAMPFIRE = idOf('soul_campfire');
const ID_LAVA_CAULDRON = idOf('lava_cauldron');
const ID_SCAFFOLDING = idOf('scaffolding');

/** Blocks that swallow all fall damage when you land on them. */
const SOFT_LANDING = new Set([ID_SLIME_BLOCK, ID_HONEY_BLOCK, ID_HAY_BLOCK, ID_COBWEB, ID_POWDER_SNOW]);
// Beds break a fall too; they are a family, so match by name suffix once.
const BED_IDS = new Set();
(function collectBeds() {
  // 16 coloured beds share the `_bed` suffix.
  for (let id = 0; id < 4096; id++) {
    const d = getBlock(id);
    if (!d || d.id !== id || !d.name) continue;
    if (d.name.endsWith('_bed')) BED_IDS.add(id);
  }
})();

/** Blocks that hurt on contact: id -> { damage, type, perTick }. */
const CONTACT_DAMAGE = new Map();
if (ID_CACTUS >= 0) CONTACT_DAMAGE.set(ID_CACTUS, { damage: 1, type: 'cactus', interval: 10 });
if (ID_SWEET_BERRY_BUSH >= 0) CONTACT_DAMAGE.set(ID_SWEET_BERRY_BUSH, { damage: 1, type: 'sweet_berry_bush', interval: 10 });
if (ID_MAGMA_BLOCK >= 0) CONTACT_DAMAGE.set(ID_MAGMA_BLOCK, { damage: 1, type: 'hot_floor', interval: 10 });

/** Blocks that set you on fire simply by standing in them. */
const BURNING_BLOCKS = new Set([ID_FIRE, ID_SOUL_FIRE, ID_CAMPFIRE, ID_SOUL_CAMPFIRE, ID_LAVA_CAULDRON].filter((i) => i >= 0));

// ---------------------------------------------------------------------------
// Collision scratch space. Physics runs for every entity every frame, so the
// only allocation left in the hot path is the AABB list blockBoxes() returns.
// ---------------------------------------------------------------------------
const _moveBox = new AABB();
const _stepBox = new AABB();
const _probeBox = new AABB();
const _fluidBox = new AABB();
const _pushBox = new AABB();
const _boxes = [];
const _stepBoxes = [];
const _ledgeOut = { dx: 0, dz: 0 };
let _clipHit = false;

/** Height of a fluid column from its metadata, matching the mesher. */
function fluidHeight(meta) {
  if (meta & 8) return 1;
  return (8 - (meta & 7)) / 9;
}

/** True when this block participates in entity collision. */
function blockCollides(def) {
  return def.solid && def.collision !== 'none';
}

/**
 * Fills `out` with every block collision box overlapping the region swept by
 * `box` moving (dx, dy, dz), plus `extraUp` blocks of headroom for step-ups.
 */
function gatherBoxes(world, box, dx, dy, dz, extraUp, out) {
  out.length = 0;
  if (!world) return out;
  let x0 = Math.floor(Math.min(box.x0, box.x0 + dx) - 0.001);
  let x1 = Math.floor(Math.max(box.x1, box.x1 + dx) + 0.001);
  let y0 = Math.floor(Math.min(box.y0, box.y0 + dy) - 0.001);
  let y1 = Math.floor(Math.max(box.y1, box.y1 + dy) + extraUp + 0.001);
  let z0 = Math.floor(Math.min(box.z0, box.z0 + dz) - 0.001);
  let z1 = Math.floor(Math.max(box.z1, box.z1 + dz) + 0.001);
  // A teleport or a wild velocity must never turn into a million-block scan.
  if (x1 - x0 > 24) x1 = x0 + 24;
  if (y1 - y0 > 24) y1 = y0 + 24;
  if (z1 - z0 > 24) z1 = z0 + 24;
  if (y0 < 0) y0 = 0;
  if (y1 > WORLD_HEIGHT - 1) y1 = WORLD_HEIGHT - 1;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const v = world.getRaw(x, y, z);
        const id = v & ID_MASK;
        if (id === 0) continue;
        const def = getBlock(id);
        if (!blockCollides(def)) continue;
        const list = blockBoxes(id, (v >>> 12) & 15, x, y, z);
        for (let i = 0; i < list.length; i++) out.push(list[i]);
      }
    }
  }
  return out;
}

/** Clips a Y movement so `e` cannot pass through `o`. */
function clipY(e, o, dy) {
  if (e.x1 <= o.x0 + EPS || e.x0 >= o.x1 - EPS) return dy;
  if (e.z1 <= o.z0 + EPS || e.z0 >= o.z1 - EPS) return dy;
  if (dy > 0 && o.y0 >= e.y1 - EPS) {
    const d = o.y0 - e.y1;
    if (d < dy) return d < 0 ? 0 : d;
  } else if (dy < 0 && o.y1 <= e.y0 + EPS) {
    const d = o.y1 - e.y0;
    if (d > dy) return d > 0 ? 0 : d;
  }
  return dy;
}

/** Clips an X movement so `e` cannot pass through `o`. */
function clipX(e, o, dx) {
  if (e.y1 <= o.y0 + EPS || e.y0 >= o.y1 - EPS) return dx;
  if (e.z1 <= o.z0 + EPS || e.z0 >= o.z1 - EPS) return dx;
  if (dx > 0 && o.x0 >= e.x1 - EPS) {
    const d = o.x0 - e.x1;
    if (d < dx) return d < 0 ? 0 : d;
  } else if (dx < 0 && o.x1 <= e.x0 + EPS) {
    const d = o.x1 - e.x0;
    if (d > dx) return d > 0 ? 0 : d;
  }
  return dx;
}

/** Clips a Z movement so `e` cannot pass through `o`. */
function clipZ(e, o, dz) {
  if (e.y1 <= o.y0 + EPS || e.y0 >= o.y1 - EPS) return dz;
  if (e.x1 <= o.x0 + EPS || e.x0 >= o.x1 - EPS) return dz;
  if (dz > 0 && o.z0 >= e.z1 - EPS) {
    const d = o.z0 - e.z1;
    if (d < dz) return d < 0 ? 0 : d;
  } else if (dz < 0 && o.z1 <= e.z0 + EPS) {
    const d = o.z1 - e.z0;
    if (d > dz) return d > 0 ? 0 : d;
  }
  return dz;
}

// The three clip-all helpers report contact through the shared `_clipHit`
// flag so the caller can tell "moved freely" from "stopped against a wall".
function clipAllY(list, e, dy) {
  _clipHit = false;
  for (let i = 0; i < list.length; i++) {
    const n = clipY(e, list[i], dy);
    if (n !== dy) { dy = n; _clipHit = true; }
  }
  return dy;
}
function clipAllX(list, e, dx) {
  _clipHit = false;
  for (let i = 0; i < list.length; i++) {
    const n = clipX(e, list[i], dx);
    if (n !== dx) { dx = n; _clipHit = true; }
  }
  return dx;
}
function clipAllZ(list, e, dz) {
  _clipHit = false;
  for (let i = 0; i < list.length; i++) {
    const n = clipZ(e, list[i], dz);
    if (n !== dz) { dz = n; _clipHit = true; }
  }
  return dz;
}

/** True when any solid block box overlaps `box`. */
function boxCollides(world, box) {
  if (!world) return false;
  const y0 = Math.max(0, Math.floor(box.y0 + EPS));
  const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(box.y1 - EPS));
  const x0 = Math.floor(box.x0 + EPS), x1 = Math.floor(box.x1 - EPS);
  const z0 = Math.floor(box.z0 + EPS), z1 = Math.floor(box.z1 - EPS);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const v = world.getRaw(x, y, z);
        const id = v & ID_MASK;
        if (id === 0) continue;
        const def = getBlock(id);
        if (!blockCollides(def)) continue;
        const list = blockBoxes(id, (v >>> 12) & 15, x, y, z);
        for (let i = 0; i < list.length; i++) if (list[i].intersects(box)) return true;
      }
    }
  }
  return false;
}

/** A damage source in the shape combat.js hands around. */
function mkSource(type, entity = null, extra = null) {
  const src = {
    type, entity, direct: null, amount: 0,
    bypassArmor: false, bypassCooldown: false, bypassInvulnerable: false,
    fire: false, magic: false, projectile: false, fall: false, explosion: false,
  };
  if (extra) for (const k in extra) src[k] = extra[k];
  return src;
}

/** Fire-and-forget sound helper; audio is optional and may not be booted. */
function playSound(entity, name, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || typeof a.playAt !== 'function') return;
  try { a.playAt(name, entity.x, entity.y + entity.height * 0.5, entity.z, volume, pitch); } catch { /* optional */ }
}

/** Fire-and-forget particle helper. */
function spawnParticles(entity, type, count, opts = null) {
  const p = Game.particles;
  if (!p || typeof p.spawn !== 'function') return;
  try {
    p.spawn(type, entity.x, entity.y + entity.height * 0.5, entity.z,
      Object.assign({ count, spread: entity.width }, opts || {}));
  } catch { /* optional */ }
}

// ===========================================================================
// Entity
// ===========================================================================

/**
 * The base of everything that moves. Owns position, velocity, the swept-AABB
 * collision solver, fluids, fire, fall damage, status effects and portals.
 */
export class Entity {
  /**
   * @param {object} world the World this entity lives in (may be null)
   * @param {number} x feet-centre X
   * @param {number} y feet Y
   * @param {number} z feet-centre Z
   */
  constructor(world, x = 0, y = 0, z = 0) {
    this.id = Entity.nextId++;
    this.type = 'entity';
    this.world = world || null;

    this.x = x; this.y = y; this.z = z;
    this.px = x; this.py = y; this.pz = z;      // previous frame, for interpolation
    this.vx = 0; this.vy = 0; this.vz = 0;

    this.yaw = 0; this.pitch = 0;
    this.headYaw = 0; this.bodyYaw = 0; this.headPitch = 0;
    this.prevYaw = 0; this.prevPitch = 0;

    this.width = 0.6; this.height = 1.8;
    this.eyeHeight = this.height * 0.85;

    // --- environment flags, refreshed every update() ---
    this.onGround = false;
    this.horizontalCollision = false;
    this.verticalCollision = false;
    this.collidedCeiling = false;
    this.inWater = false;
    this.inLava = false;
    this.inWeb = false;
    this.submerged = false;         // eyes under water
    this.submergedInLava = false;
    this.waterDepth = 0;            // blocks of water covering the feet
    this.onClimbable = false;
    this.inPortal = false;
    this.slipperiness = 0.6;
    this.groundSlow = 1;            // extra per-tick drag (soul sand)
    this.groundBlock = 0;
    this.climbSpeed = CLIMB_SPEED;
    this.autoClimb = true;          // mobs grab ladders when they bump into one
    this._endPortalHit = false;
    this._burnBlock = false;
    this._wasInWater = false;
    this.jumping = false;           // set by input/AI; drives buoyancy in fluids

    // --- health & state ---
    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.absorption = 0;
    this.dead = false;
    this.removed = false;
    this.age = 0;                   // ticks alive
    this.fireTicks = 0;
    this.hurtTime = 0;
    this.maxHurtTime = 0;
    this.hurtDir = 0;
    this.deathTime = 0;
    this.invulnerable = false;
    this.invulnerableTicks = 0;
    this.noClip = false;
    this.fireImmune = false;
    this.fireResistant = false;
    this.canBreatheUnderwater = false;
    this.waterMob = false;
    this.pushable = true;
    this.persistent = false;      // never despawned or auto-removed on death
    this.isPlayer = false;

    // --- physics knobs ---
    this.gravity = GRAVITY;
    this.drag = AIR_FRICTION;               // horizontal velocity kept per airborne tick
    this.dragY = AIR_FRICTION_Y;
    this.groundFriction = GROUND_FRICTION;
    this.terminalVelocity = TERMINAL_VELOCITY;
    this.stepHeight = 0;
    this.velocityScale = 1;
    this.noGravity = false;
    this.frictionEnabled = true;

    // --- status ---
    /** @type {Map<string, {level:number, ticks:number, ambient:boolean}>} */
    this.effects = new Map();
    this.fallDistance = 0;
    this.airSupply = MAX_AIR;
    this.maxAirSupply = MAX_AIR;
    this.lastDamageSource = null;
    this.lastDamageAmount = 0;
    this.canPickUpLoot = false;

    // --- portals ---
    this.portalTicks = 0;
    this.portalCooldown = 0;

    // --- bookkeeping ---
    this._updatedSinceTick = false;
    this._drownTimer = 0;
    this._contactTimer = 0;
    this._lavaTimer = 0;
    this._bounced = false;
  }

  // ---- geometry ----------------------------------------------------------

  /**
   * Axis-aligned bounding box in world space.
   * @param {AABB} [out] optional box to fill (avoids allocating)
   * @returns {AABB}
   */
  aabb(out) {
    const b = out || new AABB();
    const hw = this.width * 0.5;
    return b.set(this.x - hw, this.y, this.z - hw, this.x + hw, this.y + this.height, this.z + hw);
  }

  /** World position of the eyes. @returns {{x:number,y:number,z:number}} */
  getEyePos(out) {
    const o = out || { x: 0, y: 0, z: 0 };
    o.x = this.x; o.y = this.y + this.eyeHeight; o.z = this.z;
    return o;
  }

  /** Unit look vector derived from yaw/pitch. */
  getLookVec(out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const cp = Math.cos(this.pitch);
    o.x = -Math.sin(this.yaw) * cp;
    o.y = -Math.sin(this.pitch);
    o.z = Math.cos(this.yaw) * cp;
    return o;
  }

  /** Straight-line distance to another entity. */
  distanceTo(e) {
    if (!e) return Infinity;
    return Math.sqrt(this.distanceToSq(e));
  }

  /** Squared distance to an entity, or to a point when given three numbers. */
  distanceToSq(x, y, z) {
    let tx, ty, tz;
    if (typeof x === 'object' && x !== null) { tx = x.x; ty = x.y; tz = x.z; }
    else { tx = x; ty = y; tz = z; }
    const dx = this.x - tx, dy = this.y - ty, dz = this.z - tz;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Points yaw/pitch at a world position (eye to point). */
  lookAt(x, y, z) {
    const dx = x - this.x;
    const dy = y - (this.y + this.eyeHeight);
    const dz = z - this.z;
    const flat = Math.sqrt(dx * dx + dz * dz);
    this.yaw = Math.atan2(-dx, dz);
    this.pitch = -Math.atan2(dy, flat);
    this.headYaw = this.yaw;
    this.headPitch = this.pitch;
  }

  /** True while the entity is in the world and has health left. */
  isAlive() { return !this.dead && !this.removed && this.health > 0; }

  /** Teleports without any collision resolution and resets interpolation. */
  setPosition(x, y, z) {
    this.x = x; this.y = y; this.z = z;
    this.px = x; this.py = y; this.pz = z;
    this.fallDistance = 0;
    if (this.world && typeof this.world.onEntityMoved === 'function') this.world.onEntityMoved(this);
  }

  // ---- status effects ----------------------------------------------------

  /** Adds (or upgrades) a status effect. `ticks < 0` means infinite. */
  addEffect(name, ticks = 600, level = 0, opts = {}) {
    return fxAddEffect(this, name, ticks, level, opts);
  }
  /** Removes one status effect. */
  removeEffect(name) { return fxRemoveEffect(this, name); }
  /** Removes every curable effect (milk). */
  clearEffects(onlyHarmful = false) { return fxClearEffects(this, onlyHarmful); }
  /** True when the effect is active. */
  hasEffect(name) { return this.effects instanceof Map ? this.effects.has(name) : !!(this.effects && this.effects[name]); }
  /** The raw effect record, or null. */
  getEffect(name) {
    if (!this.effects) return null;
    const st = this.effects instanceof Map ? this.effects.get(name) : this.effects[name];
    return st || null;
  }
  /** Human-facing level of an effect: 1 for "Speed I", 0 when absent. */
  getEffectLevel(name) {
    const st = this.getEffect(name);
    return st ? (st.level | 0) + 1 : 0;
  }

  // ---- per-frame and per-tick drivers -------------------------------------

  /**
   * Per-frame update: interpolation snapshot, physics, environment sampling.
   * @param {number} dt seconds since the previous frame
   */
  update(dt) {
    if (this.removed) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;      // a stalled tab must not teleport anything

    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this._updatedSinceTick = true;

    this.updateEnvironment();
    this.physics(dt);
  }

  /**
   * 20 Hz logic: effects, fire, breath, portals, hurt/death animation timers.
   * The world calls this; `update()` is the per-frame half.
   */
  tick() {
    if (this.removed) return;
    this.age++;

    // If nothing has driven update() since the last tick (an entity ticked by
    // the world but not rendered, say) run one tick's worth of physics here so
    // it still falls, drowns and drifts correctly.
    if (!this._updatedSinceTick) {
      this.px = this.x; this.py = this.y; this.pz = this.z;
      this.updateEnvironment();
      this.physics(1 / TICKS_PER_SECOND);
    }
    this._updatedSinceTick = false;

    if (this.hurtTime > 0) this.hurtTime--;
    else this.lastDamageAmount = 0;
    if (this.invulnerableTicks > 0) this.invulnerableTicks--;
    if (this.portalCooldown > 0) this.portalCooldown--;

    this.tickFire();
    this.tickBreathing();
    this.tickContactDamage();
    this.tickPortal();

    try { tickEffects(this); } catch (e) { console.error('[entity] effect tick failed', e); }

    if (this.dead) {
      this.deathTime++;
      // The player and other persistent entities stay put so a respawn screen
      // (or a /kill undo) still has something to talk to.
      if (this.deathTime >= 20 && !this.isPlayer && !this.persistent) this.remove();
      return;
    }
    if (this.health <= 0) this.kill(this.lastDamageSource);

    // Falling out of the world.
    if (this.y < -16) this.hurt(4, mkSource('out_of_world', null, { bypassArmor: true, bypassCooldown: true }));
  }

  // ---- physics -----------------------------------------------------------

  /**
   * One physics step: gravity, climbing clamps, the swept move, then friction.
   * Friction runs *after* the move so a subclass that assigns velocity every
   * frame (the player, a pathing mob) gets the speed it asked for.
   */
  physics(dt) {
    if (dt <= 0) return;
    if (this.noClip) {
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      this.onGround = false;
      this.fallDistance = 0;
      this.applyFriction(dt);
      return;
    }

    this.applyGravity(dt);

    if (this.onClimbable) {
      // Ladders and vines cancel falling: you slide down slowly and never take
      // fall damage while touching one.
      if (this.vy < -this.climbSpeed) this.vy = -this.climbSpeed;
      if (this.sneaking && this.vy < 0) this.vy = 0;
      // A mob that walks into a ladder climbs it; the player steers by hand.
      if (this.autoClimb && !this.isPlayer && this.horizontalCollision && this.vy < this.climbSpeed) {
        this.vy = this.climbSpeed;
      }
      this.fallDistance = 0;
    }

    // Buoyancy: holding jump swims you up through water, and crawls up lava.
    if (this.jumping && (this.inWater || this.inLava)) {
      const accel = this.inLava ? 8 : 16;
      const cap = this.inLava ? 2 : 3.5;
      const want = this.vy + accel * dt;
      this.vy = this.vy > cap ? this.vy : Math.min(want, cap);
    }

    // Soul sand scales the *displacement* rather than the stored velocity, so
    // it slows an entity that reassigns its velocity every frame (the player,
    // a pathing mob) exactly as much as one that is coasting.
    const slow = this.onGround ? this.groundSlow : 1;
    const s = this.velocityScale || 1;
    this.move(this.vx * dt * s * slow, this.vy * dt * s, this.vz * dt * s * slow);
    this.applyFriction(dt);
  }

  /** Adds one step of gravity, damped by fluids and slow falling. */
  applyGravity(dt) {
    if (this.noGravity || this.flying) return;
    let g = this.gravity;
    if (this.inLava) g *= 0.28;
    else if (this.inWater) g *= 0.32;
    if (this.slowFalling && this.vy < 0) g *= 0.12;
    this.vy -= g * dt;
    const term = this.inWater ? 12 : this.inLava ? 6 : this.terminalVelocity;
    if (this.vy < -term) this.vy = -term;
  }

  /** Applies drag/friction for the medium the entity is standing or swimming in. */
  applyFriction(dt) {
    if (!this.frictionEnabled) return;
    const ticks = dt * TICKS_PER_SECOND;
    let f, fy;
    if (this.inLava) { f = LAVA_DRAG; fy = LAVA_DRAG; }
    else if (this.inWater) {
      // Depth Strider claws some of the water drag back.
      const ds = depthStriderFactor(this.getEquipment(EQ_FEET));
      f = WATER_DRAG + (1 - WATER_DRAG) * ds * 0.8;
      fy = WATER_DRAG;
    } else if (this.onGround) {
      f = clamp(this.groundFriction * this.slipperiness, 0.01, 0.999);
      fy = this.dragY;
    } else {
      f = this.drag;
      fy = this.dragY;
    }
    const m = Math.pow(f, ticks);
    this.vx *= m;
    this.vz *= m;
    this.vy *= Math.pow(fy, ticks);
    if (Math.abs(this.vx) < 1e-3) this.vx = 0;
    if (Math.abs(this.vz) < 1e-3) this.vz = 0;
    if (Math.abs(this.vy) < 1e-3 && this.onGround) this.vy = 0;
  }

  /**
   * Swept-AABB movement. Long moves are split into sub-steps first so a fast
   * faller cannot tunnel through a one-block floor.
   */
  move(dx, dy, dz) {
    if (this.noClip) {
      this.x += dx; this.y += dy; this.z += dz;
      this.onGround = false;
      if (this.world && typeof this.world.onEntityMoved === 'function') this.world.onEntityMoved(this);
      return;
    }
    const biggest = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    let steps = Math.ceil(biggest / MAX_MOVE_STEP);
    if (!(steps > 1)) { this.moveStep(dx, dy, dz); }
    else {
      if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
      const fx = dx / steps, fy = dy / steps, fz = dz / steps;
      this._bounced = false;
      for (let i = 0; i < steps; i++) {
        this.moveStep(fx, fy, fz);
        // A slime/bed bounce reverses vy mid-move; carrying on with the
        // remaining downward sub-steps would immediately cancel it.
        if (this._bounced) break;
        // Fully stuck: no point grinding through the remaining sub-steps.
        if (this.horizontalCollision && this.verticalCollision && this.vx === 0 && this.vz === 0 && this.vy === 0) break;
      }
    }
    if (this.world && typeof this.world.onEntityMoved === 'function') this.world.onEntityMoved(this);
  }

  /** One collision pass: Y, then X, then Z, then the step-up retry. */
  moveStep(dx, dy, dz) {
    const world = this.world;
    if (!world) { this.x += dx; this.y += dy; this.z += dz; return; }

    const wasOnGround = this.onGround;

    // Cobwebs: heavy slow, and they kill all momentum.
    if (this.inWeb) {
      dx *= 0.25; dy *= 0.05; dz *= 0.25;
      this.vx = 0; this.vy = 0; this.vz = 0;
      this.fallDistance = 0;
    }

    // The classic sneak edge check: a sneaking player on the ground refuses any
    // horizontal move that would leave nothing solid under the box.
    if (this.sneaking && wasOnGround && dy <= 0) {
      const r = this.clampToLedge(dx, dz);
      dx = r.dx; dz = r.dz;
    }

    const box = this.aabb(_moveBox);
    const headroom = this.stepHeight > 0 ? this.stepHeight : 0;
    gatherBoxes(world, box, dx, dy, dz, headroom, _boxes);

    const wantDx = dx, wantDy = dy, wantDz = dz;

    // --- Y first: the axis that decides onGround ---
    let ndy = clipAllY(_boxes, box, dy);
    const hitY = _clipHit;
    box.offset(0, ndy, 0);

    // --- X ---
    let ndx = clipAllX(_boxes, box, dx);
    const hitX = _clipHit;
    box.offset(ndx, 0, 0);

    // --- Z ---
    let ndz = clipAllZ(_boxes, box, dz);
    const hitZ = _clipHit;
    box.offset(0, 0, ndz);

    let blockedH = hitX || hitZ;
    let stoppedX = hitX, stoppedZ = hitZ, stoppedY = hitY;
    let stepped = false;

    // --- step up ---------------------------------------------------------
    // Retry the whole horizontal move from a raised start; keep it only when it
    // covers more ground and ends standing on something.
    if (blockedH && this.stepHeight > 0 && (wasOnGround || (wantDy < 0 && hitY))) {
      const r = this.tryStepUp(wantDx, wantDy, wantDz, ndx, ndz);
      if (r) {
        stepped = true;
        ndx = r.dx; ndy = r.dy; ndz = r.dz;
        blockedH = r.blocked;
        stoppedX = r.blockedX; stoppedZ = r.blockedZ; stoppedY = true;
        box.copy(r.box);
      }
    }

    // --- commit ----------------------------------------------------------
    this.x = box.cx;
    this.y = box.y0;
    this.z = box.cz;

    this.horizontalCollision = blockedH;
    this.verticalCollision = stoppedY;
    this.collidedCeiling = hitY && wantDy > 0 && !stepped;

    if (stepped) this.onGround = true;
    else if (hitY && wantDy <= 0) this.onGround = true;
    else if (hitY) this.onGround = false;
    else if (Math.abs(wantDy) < 1e-9) {
      // Standing perfectly still (or held by a ladder): probe just below.
      this.onGround = this.groundProbe();
    } else {
      this.onGround = false;
    }

    // Velocity bookkeeping: contact zeroes the axis that hit.
    if (stoppedX) this.vx = 0;
    if (stoppedZ) this.vz = 0;
    if (stepped) this.vy = 0;
    else if (hitY) {
      if (wantDy < 0) this.onLanded();
      else this.vy = 0;
    }

    // Fall distance accumulates while descending, including the final partial
    // step into the floor - miss that and every fall reads a block too short.
    if (ndy < 0) this.fallDistance -= ndy;
    if (this.onClimbable) this.fallDistance = 0;
    if (this.onGround && this.fallDistance > 0) {
      this.fall(this.fallDistance);
      this.fallDistance = 0;
    }

    // Honey blocks grab walls: sliding down one is slow.
    if (this.horizontalCollision && this.vy < 0 && this.touchingHoney()) {
      if (this.vy < -1.2) this.vy = -1.2;
      this.fallDistance = 0;
    }

    // Soul sand drags your feet unless the boots know better.
    if (this.onGround) this.applyGroundBlockEffects();
  }

  /**
   * The sneak ledge check. Shrinks the horizontal move in 0.05 steps until the
   * box, dropped one block, still overlaps something solid.
   * @returns {{dx:number, dz:number}}
   */
  clampToLedge(dx, dz) {
    const world = this.world;
    const base = this.aabb(_probeBox);
    const step = 0.05;
    let gx = dx, gz = dz;
    let guard = 64;

    const free = (ox, oz) => {
      _stepBox.copy(base).offset(ox, -1, oz);
      return !boxCollides(world, _stepBox);
    };

    while (gx !== 0 && guard-- > 0 && free(gx, 0)) {
      if (gx < step && gx >= -step) gx = 0;
      else if (gx > 0) gx -= step;
      else gx += step;
    }
    guard = 64;
    while (gz !== 0 && guard-- > 0 && free(0, gz)) {
      if (gz < step && gz >= -step) gz = 0;
      else if (gz > 0) gz -= step;
      else gz += step;
    }
    guard = 64;
    while (gx !== 0 && gz !== 0 && guard-- > 0 && free(gx, gz)) {
      if (gx < step && gx >= -step) gx = 0;
      else if (gx > 0) gx -= step;
      else gx += step;
      if (gz < step && gz >= -step) gz = 0;
      else if (gz > 0) gz -= step;
      else gz += step;
    }
    _ledgeOut.dx = gx; _ledgeOut.dz = gz;
    return _ledgeOut;
  }

  /**
   * Retries a blocked horizontal move raised by up to `stepHeight`.
   * @returns {null|{dx:number,dy:number,dz:number,box:AABB,blocked:boolean}}
   */
  tryStepUp(dx, dy, dz, plainDx, plainDz) {
    const world = this.world;
    const box = this.aabb(_stepBox);
    gatherBoxes(world, box, dx, dy, dz, this.stepHeight + 0.5, _stepBoxes);

    // 1. rise
    let up = clipAllY(_stepBoxes, box, this.stepHeight);
    if (up <= 1e-6) return null;
    box.offset(0, up, 0);

    // 2. horizontal again from up there
    let sdx = clipAllX(_stepBoxes, box, dx);
    const blockedX = _clipHit;
    box.offset(sdx, 0, 0);
    let sdz = clipAllZ(_stepBoxes, box, dz);
    const blockedZ = _clipHit;
    box.offset(0, 0, sdz);

    // Not actually better than the flat attempt: keep the flat one.
    if (sdx * sdx + sdz * sdz <= plainDx * plainDx + plainDz * plainDz + 1e-9) return null;

    // 3. settle back down onto whatever is there
    let down = clipAllY(_stepBoxes, box, -up);
    const landedOnSomething = _clipHit;
    box.offset(0, down, 0);

    // A step that ends in mid-air (walking off the top of the step) is not a
    // step, it is a hop; vanilla refuses it and so do we.
    if (!landedOnSomething) return null;

    return {
      dx: sdx, dy: up + down, dz: sdz, box,
      blocked: blockedX || blockedZ, blockedX, blockedZ,
    };
  }

  /** Cheap "is there ground within a millimetre" test. */
  groundProbe() {
    const box = this.aabb(_probeBox);
    gatherBoxes(this.world, box, 0, -0.002, 0, 0, _stepBoxes);
    clipAllY(_stepBoxes, box, -0.002);
    return _clipHit;
  }

  /** Called when the Y resolution stopped a descent. Handles bouncy blocks. */
  onLanded() {
    const id = this.blockBelowId();
    if (id === ID_SLIME_BLOCK && !this.sneaking) {
      // Slime reflects most of the impact back at you.
      this.vy = -this.vy * 0.8;
      if (Math.abs(this.vy) < 1.2) this.vy = 0;
      else {
        this.onGround = false; this.fallDistance = 0; this._bounced = true;
        playSound(this, 'slime_block_step', 0.6, 1);
      }
      return;
    }
    if (BED_IDS.has(id) && !this.sneaking) {
      this.vy = -this.vy * 0.66;
      if (Math.abs(this.vy) < 1.2) this.vy = 0;
      else { this.onGround = false; this.fallDistance = 0; this._bounced = true; }
      return;
    }
    if (id === ID_HONEY_BLOCK) { this.vy = 0; return; }
    this.vy = 0;
  }

  /** Numeric id of the block supporting the entity. */
  blockBelowId() {
    if (!this.world) return 0;
    return this.world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.08), Math.floor(this.z));
  }

  /** True when any block the entity overlaps (or stands on) is honey. */
  touchingHoney() {
    if (!this.world || ID_HONEY_BLOCK < 0) return false;
    const box = this.aabb(_pushBox).expand(0.06, 0, 0.06);
    const y0 = Math.max(0, Math.floor(box.y0));
    const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(box.y1));
    for (let y = y0; y <= y1; y++) {
      for (let z = Math.floor(box.z0); z <= Math.floor(box.z1); z++) {
        for (let x = Math.floor(box.x0); x <= Math.floor(box.x1); x++) {
          if (this.world.getBlock(x, y, z) === ID_HONEY_BLOCK) return true;
        }
      }
    }
    return false;
  }

  /**
   * Records the slipperiness and the extra per-tick drag of whatever is
   * underfoot. Nothing here touches velocity directly: `applyFriction` folds
   * `groundSlow` in with the right dt exponent, so a 144 Hz frame and a 30 Hz
   * frame slow you by the same amount.
   */
  applyGroundBlockEffects() {
    const id = this.blockBelowId();
    this.groundBlock = id;
    const def = getBlock(id);
    // Honey and ice carry their own slipperiness, which is the whole effect.
    this.slipperiness = def.slipperiness !== undefined ? def.slipperiness : 0.6;
    if (id === ID_SOUL_SAND) {
      const soulSpeed = getEnchant(this.getEquipment(EQ_FEET), 'soul_speed');
      this.groundSlow = soulSpeed > 0 ? Math.min(1.08, 1 + 0.03 * soulSpeed) : 0.4;
    } else {
      this.groundSlow = 1;
    }
  }

  // ---- environment sampling ----------------------------------------------

  /**
   * Samples every block the bounding box overlaps and refreshes the fluid,
   * cobweb, climbable and portal flags plus the slipperiness underfoot.
   */
  updateEnvironment() {
    const world = this.world;
    this.inWater = false; this.inLava = false; this.inWeb = false;
    this.onClimbable = false; this.inPortal = false;
    this.submerged = false; this.submergedInLava = false;
    this.waterDepth = 0;
    this._endPortalHit = false;
    if (!world) return;

    const box = this.aabb(_fluidBox);
    // Vanilla shrinks the fluid probe slightly so brushing a wall of water at
    // the very edge does not count as swimming.
    const x0 = Math.floor(box.x0 + 0.001), x1 = Math.floor(box.x1 - 0.001);
    const z0 = Math.floor(box.z0 + 0.001), z1 = Math.floor(box.z1 - 0.001);
    const y0 = Math.max(0, Math.floor(box.y0 + 0.001));
    const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(box.y1 - 0.001));
    const eyeY = this.y + this.eyeHeight;

    let waterTop = -Infinity, lavaTop = -Infinity;
    let burn = false;

    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const v = world.getRaw(x, y, z);
          const id = v & ID_MASK;
          if (id === 0) continue;
          const def = getBlock(id);
          const meta = (v >>> 12) & 15;

          if (def.liquid === 'water') {
            const top = y + fluidHeight(meta);
            if (top > box.y0) { this.inWater = true; if (top > waterTop) waterTop = top; }
          } else if (def.liquid === 'lava') {
            const top = y + fluidHeight(meta);
            if (top > box.y0) { this.inLava = true; if (top > lavaTop) lavaTop = top; }
          }
          if (id === ID_COBWEB) this.inWeb = true;
          if (def.climbable) this.onClimbable = true;
          if (id === ID_NETHER_PORTAL) this.inPortal = true;
          if (id === ID_END_PORTAL || id === ID_END_GATEWAY) this._endPortalHit = true;
          if (BURNING_BLOCKS.has(id)) burn = true;
        }
      }
    }

    if (this.inWater) {
      this.waterDepth = clamp(waterTop - box.y0, 0, this.height + 1);
      this.submerged = eyeY < waterTop;
    }
    if (this.inLava) this.submergedInLava = eyeY < lavaTop;

    // Scaffolding is climbable but you only cling to it from inside.
    if (!this.onClimbable && ID_SCAFFOLDING >= 0) {
      const fx = Math.floor(this.x), fz = Math.floor(this.z);
      if (world.getBlock(fx, Math.floor(this.y), fz) === ID_SCAFFOLDING) this.onClimbable = true;
    }

    // Damage is a 20 Hz concern; update() only records what we are standing in.
    this._burnBlock = burn;
    if (this.inWater) {
      if (this.fireTicks > 0) { this.fireTicks = 0; playSound(this, 'extinguish', 0.4, 1.2); }
      // Hitting water always cancels the fall, however far it was.
      if (!this._wasInWater && this.fallDistance > 1) {
        playSound(this, 'splash', Math.min(1, 0.25 + this.fallDistance * 0.05), 1);
        spawnParticles(this, 'splash', 12, { vy: 1.5 });
      }
      this.fallDistance = 0;
    }
    this._wasInWater = this.inWater;

    if (!this.onGround) {
      const def = getBlock(this.blockBelowId());
      this.slipperiness = def.slipperiness !== undefined ? def.slipperiness : 0.6;
    }
  }

  // ---- fire, breath, contact damage, portals ------------------------------

  /** True when nothing about this entity can burn. */
  isFireImmune() {
    return this.fireImmune || this.fireResistant || this.hasEffect('fire_resistance') ||
      (this.gameMode === 'creative') || (this.gameMode === 'spectator');
  }

  /** Sets the entity alight for at least `seconds` seconds. */
  setOnFire(seconds) {
    if (this.isFireImmune()) { this.fireTicks = 0; return; }
    const ticks = Math.round(seconds * TICKS_PER_SECOND);
    if (ticks > this.fireTicks) this.fireTicks = ticks;
  }

  /** Burns for 1 damage a second; water, rain and fire resistance put it out. */
  tickFire() {
    const immune = this.isFireImmune();

    // Standing in fire, a campfire or lava keeps topping the timer up.
    if (!immune) {
      if (this._burnBlock) this.setOnFire(8);
      if (this.inLava) {
        this.setOnFire(15);
        this._lavaTimer--;
        if (this._lavaTimer <= 0) {
          this._lavaTimer = 10;
          this.hurt(4, mkSource('lava', null, { fire: true, bypassCooldown: true }));
        }
      } else {
        this._lavaTimer = 0;
      }
    } else {
      this.fireTicks = 0;
      this._lavaTimer = 0;
    }

    if (this.fireTicks <= 0) return;
    if (immune || this.inWater || this.submerged) { this.fireTicks = 0; return; }
    const w = this.world;
    if (w && typeof w.isRainingAt === 'function' &&
        w.isRainingAt(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))) {
      this.fireTicks = 0;
      playSound(this, 'extinguish', 0.5, 1.2);
      return;
    }
    this.fireTicks--;
    if ((this.fireTicks % 20) === 0) {
      this.hurt(1, mkSource('on_fire', null, { fire: true, bypassCooldown: true }));
    }
    if ((this.fireTicks & 3) === 0) spawnParticles(this, 'flame', 1, { vy: 0.4 });
  }

  /** Drains and refills the air bar; drowns when it runs out. */
  tickBreathing() {
    if (this.dead) return;
    const creative = this.gameMode === 'creative' || this.gameMode === 'spectator';
    const maxAir = this.maxAirSupply + respirationBonusTicks(this.getEquipment(EQ_HEAD));

    if (this.submerged && !this.canBreatheUnderwater && !this.waterMob && !creative && !this.invulnerable) {
      // Respiration gives a per-tick chance to skip the drain entirely.
      const resp = getEnchant(this.getEquipment(EQ_HEAD), 'respiration');
      const skip = resp > 0 && Math.random() < resp / (resp + 1);
      if (!skip) this.airSupply--;
      if (this.airSupply <= 0) {
        this.airSupply = 0;
        this._drownTimer++;
        if (this._drownTimer >= 20) {
          this._drownTimer = 0;
          this.hurt(2, mkSource('drown', null, { bypassArmor: true, bypassCooldown: true }));
        }
        if ((this.age & 3) === 0) spawnParticles(this, 'bubble', 2, { vy: 0.5 });
      }
    } else if (this.waterMob && !this.inWater && !this.canBreatheUnderwater) {
      // A fish out of water suffocates the same way.
      this.airSupply--;
      if (this.airSupply <= 0) {
        this.airSupply = 0;
        this._drownTimer++;
        if (this._drownTimer >= 20) { this._drownTimer = 0; this.hurt(2, mkSource('dry_out', null, { bypassArmor: true })); }
      }
    } else {
      this._drownTimer = 0;
      if (this.airSupply < maxAir) this.airSupply = Math.min(maxAir, this.airSupply + 4);
    }
    if (this.airSupply > maxAir) this.airSupply = maxAir;
  }

  /** Cactus, sweet berries, magma blocks and wither roses. */
  tickContactDamage() {
    const world = this.world;
    if (!world || this.dead || CONTACT_DAMAGE.size === 0) return;
    if (this._contactTimer > 0) { this._contactTimer--; return; }

    // Magma blocks burn what stands on them, so they are a floor check rather
    // than an overlap check.
    if (this.onGround && this.groundBlock === ID_MAGMA_BLOCK &&
        !this.sneaking && !this.isFireImmune()) {
      this.hurt(1, mkSource('hot_floor', null, { fire: true, bypassCooldown: true }));
      this._contactTimer = 10;
      return;
    }

    const box = this.aabb(_pushBox);
    const y0 = Math.max(0, Math.floor(box.y0 + 0.001));
    const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(box.y1 - 0.001));
    for (let y = y0; y <= y1; y++) {
      for (let z = Math.floor(box.z0 + 0.001); z <= Math.floor(box.z1 - 0.001); z++) {
        for (let x = Math.floor(box.x0 + 0.001); x <= Math.floor(box.x1 - 0.001); x++) {
          const id = world.getBlock(x, y, z);
          if (id === 0) continue;
          if (id === ID_WITHER_ROSE) { this.addEffect('wither', 40, 0); continue; }
          if (id === ID_MAGMA_BLOCK) continue;   // handled above, as a floor
          const c = CONTACT_DAMAGE.get(id);
          if (!c) continue;
          this.hurt(c.damage, mkSource(c.type, null, { bypassCooldown: true }));
          this._contactTimer = c.interval;
          return;
        }
      }
    }
  }

  /** Nether portals charge up for 4 seconds; end portals fire instantly. */
  tickPortal() {
    if (this.portalCooldown > 0) { this.portalTicks = 0; return; }
    if (this._endPortalHit) {
      const dim = this.world ? this.world.dimension : DIM_OVERWORLD;
      this.requestDimension(dim === DIM_END ? DIM_OVERWORLD : DIM_END);
      return;
    }
    if (!this.inPortal) {
      if (this.portalTicks > 0) this.portalTicks -= 2;
      if (this.portalTicks < 0) this.portalTicks = 0;
      return;
    }
    this.portalTicks++;
    const threshold = (this.gameMode === 'creative') ? 1 : PORTAL_TRIGGER_TICKS;
    if ((this.portalTicks & 7) === 0) spawnParticles(this, 'portal', 2, {});
    if (this.portalTicks >= threshold) {
      this.portalTicks = 0;
      const dim = this.world ? this.world.dimension : DIM_OVERWORLD;
      this.requestDimension(dim === DIM_NETHER ? DIM_OVERWORLD : DIM_NETHER);
    }
  }

  /**
   * Rescales the entity's coordinates for the destination and asks the
   * integrator to perform the swap. main.js listens for 'dimensionchange'.
   */
  requestDimension(target) {
    const from = this.world ? this.world.dimension : DIM_OVERWORLD;
    if (target === from) return;
    this.portalCooldown = PORTAL_COOLDOWN_TICKS;
    this.portalTicks = 0;

    if (from === DIM_OVERWORLD && target === DIM_NETHER) {
      this.x /= NETHER_SCALE; this.z /= NETHER_SCALE;
    } else if (from === DIM_NETHER && target === DIM_OVERWORLD) {
      this.x *= NETHER_SCALE; this.z *= NETHER_SCALE;
    } else if (target === DIM_END) {
      this.x = 0.5; this.z = 0.5; this.y = Math.max(this.y, SEA_LEVEL + 8);
    }
    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.fallDistance = 0;

    playSound(this, 'portal', 0.7, 1);
    Game.emit('portal', this, target, from);
    // Only the player drags the camera between dimensions.
    if (this.isPlayer || Game.player === this) Game.emit('dimensionchange', from, target);
  }

  // ---- damage ------------------------------------------------------------

  /**
   * Applies damage. Returns true when health (or absorption) actually moved.
   * @param {number} amount half-hearts
   * @param {object} [source] a damage source object (see combat.js)
   */
  hurt(amount, source = null) {
    if (this.removed || this.dead) return false;
    if (this.invulnerable && !(source && source.bypassInvulnerable)) return false;
    if (this.gameMode === 'creative' && !(source && source.type === 'out_of_world')) return false;
    if (this.gameMode === 'spectator') return false;
    if (!(amount > 0)) return false;
    if (this.isFireImmune() && source && source.fire) return false;

    const bypassCooldown = !!(source && source.bypassCooldown);
    if (!bypassCooldown && this.hurtTime > HURT_RESISTANT_TICKS / 2) {
      // Inside the invulnerability window only a *bigger* hit lands, and only
      // for the difference.
      if (amount <= this.lastDamageAmount) return false;
      amount -= this.lastDamageAmount;
    }

    const dealt = this.applyDamage(amount, source);
    if (dealt <= 0) return false;

    this.lastDamageSource = source;
    this.lastDamageAmount = Math.max(this.lastDamageAmount, amount);
    if (!bypassCooldown) { this.hurtTime = HURT_RESISTANT_TICKS; this.maxHurtTime = HURT_RESISTANT_TICKS; }
    else if (this.hurtTime <= 0) { this.hurtTime = 5; this.maxHurtTime = 5; }

    if (source && source.entity) {
      const dx = source.entity.x - this.x, dz = source.entity.z - this.z;
      this.hurtDir = Math.atan2(dz, dx);
      // `knockedBack` keeps combat.js and this path from stacking two shoves
      // when both run for the same hit.
      if (!source.noKnockback && !source.knockedBack) {
        source.knockedBack = true;
        this.knockback(dx, dz, source.knockback !== undefined ? source.knockback : 0.4);
      }
    }

    this.onHurt(dealt, source);
    if (this.health <= 0) this.kill(source);
    return true;
  }

  /** Subtracts damage from absorption then health. Returns the amount taken. */
  applyDamage(amount, source) {
    let dmg = amount;
    if (this.absorption > 0) {
      const eaten = Math.min(this.absorption, dmg);
      this.absorption -= eaten;
      dmg -= eaten;
      if (dmg <= 0) return amount;
    }
    const before = this.health;
    this.health = Math.max(0, this.health - dmg);
    return (before - this.health) + (amount - dmg);
  }

  /** Hook for subclasses: sounds, particles, aggro. */
  onHurt(amount, source) {
    playSound(this, this.hurtSound || 'hurt', 0.8, 1 + (Math.random() - 0.5) * 0.2);
    spawnParticles(this, 'damage', 4, {});
  }

  /** Restores health, capped by maxHealth. */
  heal(amount) {
    if (this.dead || !(amount > 0)) return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }

  /** Kills the entity: fires death effects, drops and the death animation. */
  kill(source = null) {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.deathTime = 0;
    this.lastDamageSource = source || this.lastDamageSource;
    try { triggerDeathEffects(this); } catch { /* optional */ }
    try { this.onDeath(this.lastDamageSource); } catch (e) { console.error('[entity] onDeath failed', e); }
    Game.emit('entitydeath', this, this.lastDamageSource);
    playSound(this, this.deathSound || 'death', 0.9, 1);
  }

  /** Override point. Called once, when the entity dies. */
  onDeath(source) { /* base entities drop nothing */ }

  /** Unlinks the entity from the world. */
  remove() {
    if (this.removed) return;
    this.removed = true;
    if (this.world && typeof this.world.removeEntity === 'function') this.world.removeEntity(this);
  }

  /**
   * Vanilla knockback. `(dx, dz)` points from this entity **towards the source
   * of the hit** (i.e. `attacker.x - target.x`); the entity is pushed the other
   * way. `strength` is in vanilla units (0.4 for a normal melee hit).
   */
  knockback(dx, dz, strength = 0.4) {
    const resist = clamp(this.getKnockbackResist() + knockbackResistance(this), 0, 1);
    strength *= 1 - resist;
    if (strength <= 0) return;
    let len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-4) {
      // Hit from exactly above/below: shove in a random direction so the victim
      // never sticks to the attacker.
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a); dz = Math.sin(a); len = 1;
    }
    const s = strength * 20;            // vanilla blocks/tick -> our blocks/s
    this.vx = this.vx * 0.5 - (dx / len) * s;
    this.vz = this.vz * 0.5 - (dz / len) * s;
    if (this.onGround) {
      this.vy = this.vy * 0.5 + s;
      if (this.vy > 8) this.vy = 8;
      this.onGround = false;
    }
  }

  /** Adds velocity directly, in blocks per second. */
  addVelocity(dx, dy, dz) { this.vx += dx; this.vy += dy; this.vz += dz; }

  // ---- fall damage --------------------------------------------------------

  /**
   * Resolves a landing. Damage is `floor(distance - 3)`, cancelled entirely by
   * water, hay bales, slime, honey, cobwebs, ladders and slow falling, and
   * reduced by jump boost and (through the armour maths) feather falling.
   */
  fall(distance) {
    if (!(distance > 0)) return;
    if (this.noFallDamage || this.flying || this.noClip) return;
    if (this.gameMode === 'creative' || this.gameMode === 'spectator') return;
    if (this.inWater || this.inLava || this.inWeb || this.onClimbable) return;

    const landing = this.blockBelowId();
    if (SOFT_LANDING.has(landing) || BED_IDS.has(landing)) {
      if (landing === ID_HAY_BLOCK) playSound(this, 'step_grass', 0.4, 0.9);
      return;
    }

    const reduction = fallDamageReduction(this);     // Infinity for slow falling
    if (!isFinite(reduction)) return;
    // The epsilon keeps a 6.0-block drop that accumulated as 5.99999 from
    // reading as a 5-block one.
    const damage = Math.floor(distance + 1e-6 - 3 - reduction);
    if (damage <= 0) {
      if (distance > 1.2) playSound(this, 'step_stone', 0.25, 1);
      return;
    }
    this.hurt(damage, mkSource('fall', null, { fall: true, bypassCooldown: true }));
    playSound(this, 'fall_big', 0.9, 1);
  }

  // ---- equipment (overridden by LivingEntity / Player) --------------------

  /** Item stack in an equipment slot. The base entity wears nothing. */
  getEquipment(_slot) { return null; }
  /** No-op on the base entity. */
  setEquipment(_slot, _stack) { }
  /** 0..1 resistance to knockback. LivingEntity folds armour into this. */
  getKnockbackResist() { return clamp(this.knockbackResist || 0, 0, 1); }

  // ---- entity/entity pushing ---------------------------------------------

  /** Nudges overlapping entities apart, the way vanilla crowds behave. */
  pushOutOfEntities(strength = 1.6) {
    const world = this.world;
    if (!world || !this.pushable || this.dead) return;
    const box = this.aabb(_pushBox).expand(0.05, 0, 0.05);
    const others = world.entitiesInAABB(box, (e) => e !== this && e.pushable && !e.removed && !e.dead);
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      let dx = o.x - this.x, dz = o.z - this.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; }
      else { dx /= d; dz /= d; }
      const push = strength * (1 - Math.min(1, d / (this.width + o.width)));
      this.vx -= dx * push; this.vz -= dz * push;
      o.vx += dx * push; o.vz += dz * push;
    }
  }

  // ---- persistence --------------------------------------------------------

  /** Plain-object snapshot for save.js. */
  serialize() {
    return {
      type: this.type,
      id: this.id,
      x: this.x, y: this.y, z: this.z,
      vx: this.vx, vy: this.vy, vz: this.vz,
      yaw: this.yaw, pitch: this.pitch, headYaw: this.headYaw,
      health: this.health, maxHealth: this.maxHealth, absorption: this.absorption,
      fireTicks: this.fireTicks, airSupply: this.airSupply,
      fallDistance: this.fallDistance, age: this.age,
      portalCooldown: this.portalCooldown,
      dead: this.dead,
      effects: serializeEffects(this),
    };
  }

  /** Restores the fields `serialize()` wrote. */
  load(obj) {
    if (!obj) return this;
    if (obj.x !== undefined) { this.x = obj.x; this.px = obj.x; }
    if (obj.y !== undefined) { this.y = obj.y; this.py = obj.y; }
    if (obj.z !== undefined) { this.z = obj.z; this.pz = obj.z; }
    if (obj.vx !== undefined) this.vx = obj.vx;
    if (obj.vy !== undefined) this.vy = obj.vy;
    if (obj.vz !== undefined) this.vz = obj.vz;
    if (obj.yaw !== undefined) { this.yaw = obj.yaw; this.prevYaw = obj.yaw; }
    if (obj.pitch !== undefined) { this.pitch = obj.pitch; this.prevPitch = obj.pitch; }
    if (obj.headYaw !== undefined) this.headYaw = obj.headYaw;
    else this.headYaw = this.yaw;
    this.bodyYaw = this.yaw;
    if (obj.maxHealth !== undefined) this.maxHealth = obj.maxHealth;
    if (obj.health !== undefined) this.health = obj.health;
    if (obj.absorption !== undefined) this.absorption = obj.absorption;
    if (obj.fireTicks !== undefined) this.fireTicks = obj.fireTicks;
    if (obj.airSupply !== undefined) this.airSupply = obj.airSupply;
    if (obj.fallDistance !== undefined) this.fallDistance = obj.fallDistance;
    if (obj.age !== undefined) this.age = obj.age;
    if (obj.portalCooldown !== undefined) this.portalCooldown = obj.portalCooldown;
    if (obj.dead) { this.dead = true; this.health = 0; }
    if (obj.effects) { try { deserializeEffects(this, obj.effects); } catch { /* optional */ } }
    return this;
  }

  /**
   * Rebuilds an entity of this class from a `serialize()` payload. Subclasses
   * inherit this; `new this(...)` picks the right constructor.
   */
  static deserialize(obj, world) {
    const e = new this(world, obj && obj.x || 0, obj && obj.y || 0, obj && obj.z || 0);
    e.load(obj);
    return e;
  }
}

/** Monotonic entity id counter. Shared by every subclass. */
Entity.nextId = 1;

// ===========================================================================
// LivingEntity
// ===========================================================================

/**
 * Anything with health, armour, limbs and a death animation: the player, every
 * mob, armour stands. Adds animation bookkeeping, the armour damage formula,
 * an attack cooldown and loot drops.
 */
export class LivingEntity extends Entity {
  constructor(world, x, y, z) {
    super(world, x, y, z);
    this.type = 'living';
    this.living = true;

    // --- animation ---
    this.limbSwing = 0;
    this.limbSwingAmount = 0;
    this.prevLimbSwingAmount = 0;
    this.swingProgress = 0;
    this.swinging = false;
    this.swingTicks = 0;
    this.headYawSpeed = 0.35;      // how fast the head catches up with the body

    // --- combat ---
    this.attackCooldown = 0;       // ticks until the next full-strength swing
    this.attackSpeed = 1;          // swings per second at full charge
    this.attackDamage = 1;
    this.armor = 0;                // flat armour points from the definition
    this.armorToughness = 0;
    this.knockbackResist = 0;
    /** head, chest, legs, feet, mainhand, offhand */
    this.equipment = [null, null, null, null, null, null];
    this.dropChances = [0.085, 0.085, 0.085, 0.085, 0.085, 0.085];

    this.xpReward = 0;
    this.target = null;
    this.lastAttacker = null;
    this.lastAttackedTicks = 0;
    this.stepHeight = 0.6;
    this.baby = false;
    this.deathLootDropped = false;
    this.undead = false;
  }

  // ---- equipment ---------------------------------------------------------

  /** Item stack in one of the six equipment slots (0..3 armour, 4/5 hands). */
  getEquipment(slot) {
    return this.equipment[slot] || null;
  }

  /** Puts a stack in an equipment slot. */
  setEquipment(slot, stack) {
    if (slot < 0 || slot > 5) return;
    this.equipment[slot] = stack || null;
  }

  /** The four armour stacks, for the enchantment maths. @returns {Array} */
  getArmorStacks() {
    return [this.equipment[EQ_HEAD], this.equipment[EQ_CHEST], this.equipment[EQ_LEGS], this.equipment[EQ_FEET]];
  }

  /** The stack in the main hand. */
  getHeldItem() { return this.equipment[EQ_MAINHAND] || null; }
  /** The stack in the off hand. */
  getOffhandItem() { return this.equipment[EQ_OFFHAND] || null; }

  /** Total armour points: the definition's base plus every worn piece. */
  getArmorPoints() {
    let pts = this.armor || 0;
    for (let i = 0; i <= EQ_FEET; i++) {
      const s = this.equipment[i];
      if (!s || !s.item) continue;
      const def = getItem(s.item);
      if (def.armor) pts += def.armor.defense || 0;
    }
    return pts;
  }

  /** Armour toughness, which softens the high-damage penalty. */
  getArmorToughness() {
    let t = this.armorToughness || 0;
    for (let i = 0; i <= EQ_FEET; i++) {
      const s = this.equipment[i];
      if (!s || !s.item) continue;
      const def = getItem(s.item);
      if (def.armor) t += def.armor.toughness || 0;
    }
    return t;
  }

  /** @override folds every worn armour piece into the resistance. */
  getKnockbackResist() {
    let r = this.knockbackResist || 0;
    for (let i = 0; i <= EQ_FEET; i++) {
      const s = this.equipment[i];
      if (!s || !s.item) continue;
      const def = getItem(s.item);
      if (def.armor) r += def.armor.knockbackResist || 0;
    }
    return clamp(r, 0, 1);
  }

  // ---- damage maths ------------------------------------------------------

  /**
   * Vanilla's three-stage reduction: armour points (softened by toughness),
   * then protection enchantments, then the resistance effect.
   */
  computeIncomingDamage(amount, source) {
    let dmg = amount;
    const bypassArmor = !!(source && (source.bypassArmor || source.magic ||
      source.type === 'out_of_world' || source.type === 'drown' ||
      source.type === 'starve' || source.type === 'wither' || source.type === 'magic'));

    if (!bypassArmor) {
      const armor = this.getArmorPoints();
      const tough = this.getArmorToughness();
      if (armor > 0) {
        const effective = clamp(Math.min(20, Math.max(armor / 5, armor - dmg / (2 + tough / 4))), 0, 20);
        dmg *= 1 - effective / 25;
      }
    }
    if (!(source && source.bypassMagic)) {
      dmg *= 1 - damageReduction(this.getArmorStacks(), source);
    }
    dmg *= damageMultiplier(this);         // resistance effect
    return Math.max(0, dmg);
  }

  /** @override adds the armour formula in front of the base subtraction. */
  applyDamage(amount, source) {
    const reduced = this.computeIncomingDamage(amount, source);
    if (reduced <= 0) return 0;
    return super.applyDamage(reduced, source);
  }

  /** @override adds thorns, aggro bookkeeping and the hurt animation. */
  hurt(amount, source = null) {
    const wasAlive = this.isAlive();
    const applied = super.hurt(amount, source);
    if (!applied) return false;

    if (source && source.entity) {
      this.lastAttacker = source.entity;
      this.lastAttackedTicks = 0;
      // Thorns pays the attacker back out of the armour.
      const thorns = thornsDamage(this.getArmorStacks());
      if (thorns > 0 && typeof source.entity.hurt === 'function') {
        source.entity.hurt(thorns, mkSource('thorns', this, { magic: true, bypassCooldown: true }));
      }
    }
    if (wasAlive) this.limbSwingAmount = Math.max(this.limbSwingAmount, 0.35);
    return true;
  }

  // ---- attacking ---------------------------------------------------------

  /** 0..1 charge of the attack cooldown; 1 means a full-strength hit. */
  getAttackStrength() {
    const period = Math.max(1, TICKS_PER_SECOND / Math.max(0.1, this.attackSpeed));
    return clamp(1 - this.attackCooldown / period, 0, 1);
  }

  /** Resets the swing timer after an attack. */
  resetAttackCooldown() {
    this.attackCooldown = Math.max(1, Math.round(TICKS_PER_SECOND / Math.max(0.1, this.attackSpeed)));
  }

  /** Plays the arm-swing animation. */
  swingArm() {
    if (!this.swinging || this.swingTicks >= 3) { this.swinging = true; this.swingTicks = 0; }
  }

  // ---- per-tick ----------------------------------------------------------

  /** @override adds animation, cooldowns and the death countdown. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;

    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.lastAttackedTicks < 1000) this.lastAttackedTicks++;
    if (this.lastAttackedTicks > 100) this.lastAttacker = null;

    if (this.swinging) {
      this.swingTicks++;
      if (this.swingTicks >= 6) { this.swinging = false; this.swingTicks = 0; }
    }
    this.swingProgress = this.swinging ? clamp(this.swingTicks / 6, 0, 1) : 0;

    // Suffocation: a solid block inside the head.
    if (!this.dead && !this.noClip && this.world && this.isSuffocating()) {
      this.hurt(1, mkSource('in_wall', null, { bypassArmor: true }));
    }

    // Crowds spread out. Only mobs run the scan; the shove they apply is what
    // moves the player, so nobody pays for the query twice.
    if (!this.dead && !this.isPlayer && this.pushable) this.pushOutOfEntities();
  }

  /** True when an opaque solid block occupies the eye position. */
  isSuffocating() {
    const w = this.world;
    if (!w) return false;
    const x = Math.floor(this.x), y = Math.floor(this.y + this.eyeHeight), z = Math.floor(this.z);
    const id = w.getBlock(x, y, z);
    if (id === 0) return false;
    const def = getBlock(id);
    return def.solid && def.opaque && def.collision === 'full';
  }

  /** @override adds limb-swing and head-yaw smoothing. */
  update(dt) {
    if (this.removed) return;
    super.update(dt);

    // --- limb swing: how far the legs have travelled, for the walk cycle ---
    const dx = this.x - this.px, dz = this.z - this.pz;
    const travelled = Math.sqrt(dx * dx + dz * dz);
    let target = Math.min(1, travelled * (dt > 0 ? (1 / dt) : 0) * 0.22);
    if (this.dead) target = 0;
    this.prevLimbSwingAmount = this.limbSwingAmount;
    this.limbSwingAmount += (target - this.limbSwingAmount) * Math.min(1, dt * 12);
    this.limbSwing += this.limbSwingAmount * dt * TICKS_PER_SECOND * 1.6;

    // --- head follows the body, but lags behind it ---
    const bodyTarget = this.bodyYaw !== undefined ? this.bodyYaw : this.yaw;
    const diff = angleDiff(this.headYaw, this.headYawTarget !== undefined ? this.headYawTarget : this.yaw);
    this.headYaw += diff * Math.min(1, this.headYawSpeed * dt * TICKS_PER_SECOND);
    // Necks only turn so far; past that the body swings round to follow.
    const twist = angleDiff(bodyTarget, this.headYaw);
    if (Math.abs(twist) > 1.2) this.bodyYaw = bodyTarget + (twist - Math.sign(twist) * 1.2);
    this.headPitch = this.pitch;

    if (this.dead && this.deathTime > 0) this.limbSwingAmount = 0;
  }

  // ---- death -------------------------------------------------------------

  /** @override drops loot, XP and equipment, then fires the subclass hook. */
  kill(source = null) {
    if (this.dead) return;
    super.kill(source);
    if (!this.deathLootDropped) {
      this.deathLootDropped = true;
      this.dropLoot(this.lastDamageSource);
      this.dropXP(this.lastDamageSource);
    }
  }

  /** Spawns this mob's item drops through item/loot.js. */
  dropLoot(source) {
    const world = this.world;
    if (!world) return;
    if (world.gameRules && world.gameRules.doMobLoot === false) return;
    if (this.isPlayer) return;                    // player.js handles its own inventory

    let looting = 0;
    const killer = source && source.entity;
    if (killer && typeof killer.getHeldItem === 'function') {
      try { looting = lootingLevel(killer.getHeldItem()); } catch { looting = 0; }
    }

    if (_loot && typeof _loot.mobDrops === 'function') {
      let stacks = null;
      try { stacks = _loot.mobDrops(this, source, looting); } catch (e) { console.error('[entity] mobDrops failed', e); }
      if (stacks) for (let i = 0; i < stacks.length; i++) this.spawnDrop(stacks[i]);
      return;
    }
    // loot.js has not resolved yet: drop as soon as it does.
    try {
      import('../item/loot.js').then((m) => {
        _loot = m;
        const stacks = m.mobDrops ? m.mobDrops(this, source, looting) : null;
        if (stacks) for (let i = 0; i < stacks.length; i++) this.spawnDrop(stacks[i]);
      }).catch(() => { /* loot.js unavailable */ });
    } catch { /* no dynamic import */ }
  }

  /** Drops one stack at the entity's position. */
  spawnDrop(stack) {
    if (!stack || !this.world) return;
    if (_itementity && typeof _itementity.dropItem === 'function') {
      try {
        _itementity.dropItem(this.world, this.x, this.y + this.height * 0.5, this.z, stack,
          (Math.random() - 0.5) * 2, 2 + Math.random() * 2, (Math.random() - 0.5) * 2);
        return;
      } catch (e) { console.error('[entity] dropItem failed', e); }
    }
    // itementity.js has not resolved yet (first death of the session): drop it
    // as soon as the module lands rather than losing the loot.
    const w = this.world, dx = this.x, dy = this.y + this.height * 0.5, dz = this.z;
    try {
      import('./itementity.js')
        .then((m) => { _itementity = m; m.dropItem?.(w, dx, dy, dz, stack, 0, 2, 0); })
        .catch(() => { /* itementity.js unavailable */ });
    } catch { /* no dynamic import */ }
  }

  /** Drops the XP orbs this mob is worth. */
  dropXP(source) {
    const world = this.world;
    if (!world || this.xpReward <= 0) return;
    const killer = source && source.entity;
    // Vanilla only awards XP for player kills.
    if (!killer || !(killer.isPlayer || killer.type === 'player')) return;
    if (_itementity && typeof _itementity.dropXP === 'function') {
      try { _itementity.dropXP(world, this.x, this.y + 0.5, this.z, this.xpReward); } catch { /* optional */ }
    }
  }

  /** Override point for subclasses. Runs before the drops. */
  onDeath(source) { /* mobs override this */ }
}

// ===========================================================================
// Registry + driver
// ===========================================================================

/** name -> constructor, used to rebuild entities from a save file. */
export const ENTITY_TYPES = {};

/**
 * Registers an entity class under a type name so `createEntityFromSave` can
 * rebuild it. Returns the constructor for convenient chaining.
 */
export function registerEntityType(name, ctor) {
  if (!name || typeof ctor !== 'function') return ctor;
  ENTITY_TYPES[name] = ctor;
  return ctor;
}

registerEntityType('entity', Entity);
registerEntityType('living', LivingEntity);

/**
 * Rebuilds one entity from a `serialize()` payload. Unknown types degrade to a
 * plain Entity rather than throwing, so a save from an older build still loads.
 * @returns {Entity|null}
 */
export function createEntityFromSave(obj, world) {
  if (!obj || typeof obj !== 'object') return null;
  const ctor = ENTITY_TYPES[obj.type];
  let e = null;
  if (ctor) {
    try {
      e = typeof ctor.deserialize === 'function'
        ? ctor.deserialize(obj, world)
        : new ctor(world, obj.x || 0, obj.y || 0, obj.z || 0).load(obj);
    } catch (err) {
      console.warn('[entity] could not rebuild', obj.type, err);
      e = null;
    }
  }
  if (!e) {
    e = new Entity(world, obj.x || 0, obj.y || 0, obj.z || 0);
    e.load(obj);
    if (typeof obj.type === 'string') { e.type = obj.type; e.display = prettyName(obj.type); }
  }
  if (obj.id !== undefined && obj.id !== null) {
    e.id = obj.id;
    if (Entity.nextId <= obj.id) Entity.nextId = obj.id + 1;
  }
  e.world = world || e.world;
  return e;
}

/**
 * Per-frame driver for a whole world's entity list: runs `update(dt)` on every
 * live entity and keeps the world's spatial hash in step. main.js may call this
 * instead of looping itself.
 * @returns {number} how many entities were updated
 */
export function tickEntityList(world, dt) {
  if (!world || !Array.isArray(world.entities)) return 0;
  const list = world.entities;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.removed) continue;
    if (typeof e.update !== 'function') continue;
    try {
      e.update(dt);
      n++;
    } catch (err) {
      console.error('[entity] update failed for', e.type, err);
    }
    if (!e.removed && typeof world.onEntityMoved === 'function') world.onEntityMoved(e);
  }
  return n;
}

/**
 * Swim-speed helper shared by the player and water mobs: the horizontal speed
 * (blocks/s) an entity should reach while in water, after depth strider and
 * dolphin's grace.
 */
export function swimSpeedFor(entity, baseSpeed) {
  const ds = depthStriderFactor(entity.getEquipment ? entity.getEquipment(EQ_FEET) : null);
  return baseSpeed * (0.35 + 0.65 * ds) * swimSpeedMultiplier(entity);
}

/** Equipment slot indices, exported for mobs.js and player.js. */
export const EQUIP = Object.freeze({
  HEAD: EQ_HEAD, CHEST: EQ_CHEST, LEGS: EQ_LEGS, FEET: EQ_FEET,
  MAINHAND: EQ_MAINHAND, OFFHAND: EQ_OFFHAND,
});

export default Entity;
