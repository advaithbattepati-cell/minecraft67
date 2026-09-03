// ============================================================================
// projectiles.js - Everything that flies through the air and then does
// something when it stops.
//
// Three ideas carry the whole file:
//
//  1. **Ballistics.** Velocities are blocks per second (the project-wide unit),
//     so vanilla's per-tick numbers are scaled: a per-tick drag `d` becomes
//     `d^(dt*20)`, and a per-tick acceleration `a` becomes `a*20` blocks/s per
//     second. An arrow's 0.05 blocks/tick^2 gravity is therefore 20 b/s^2.
//
//  2. **Swept collision.** A projectile is small and fast, so it can never use
//     the entity mover: it would tunnel. Instead every step is a Minkowski
//     sweep of the projectile's own AABB against (a) the very same block boxes
//     `mesher.blockBoxes()` hands the player, and (b) every entity in the swept
//     region. The nearer of the two hits wins.
//
//  3. **Per-type impact.** The base class owns flight; subclasses own what
//     happens at the end of it.
//
// Nothing here assumes a sibling module exists. Combat, effects and brewing are
// static imports (they sit *below* this file), while itementity.js and mobs.js
// are pulled in lazily because they sit above it.
// ============================================================================
import {
  TICKS_PER_SECOND, WORLD_HEIGHT, ID_MASK, DIFFICULTY,
  FACE_DOWN, FACE_UP, FACE_NORTH, FACE_SOUTH, FACE_WEST, FACE_EAST, FACE_DIRS,
} from '../core/constants.js';
import { AABB, clamp } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { Game } from '../core/game.js';
import { getBlock, blockByName } from '../world/blocks.js';
import { blockBoxes } from '../render/mesher.js';
import { Entity, registerEntityType } from './entity.js';
import {
  damageEntity, damageSource, applyKnockback, explode, lightningStrike,
  setOnFire, deflectProjectile,
} from './combat.js';
import { addEffect, isUndead } from '../item/effects.js';
import { getEnchant } from '../item/enchanting.js';
import { stack as mkStack, copyStack, isEmpty } from '../item/inventory.js';
import { itemExists } from '../item/items.js';
import {
  parsePotionItem, potionEffectsFor, potionColor, resolvePotionId,
} from '../item/brewing.js';
import { fishingLoot } from '../item/loot.js';

// ---------------------------------------------------------------------------
// Lazily resolved siblings. itementity.js extends Entity and mobs.js imports
// combat.js, so both sit above this module: a static import would cycle.
// ---------------------------------------------------------------------------
const MOD = { itementity: null, mobs: null };
let _depsStarted = false;
function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, key) => {
    try { import(path).then((m) => { MOD[key] = m; }).catch(() => { /* optional */ }); }
    catch { /* environment without dynamic import */ }
  };
  grab('./itementity.js', 'itementity');
  grab('./mobs.js', 'mobs');
}
loadDeps();

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Longest distance resolved in one collision pass. Smaller = safer, slower. */
const MAX_SWEEP_STEP = 0.45;
/** Hard cap on collision passes per frame, so a teleport cannot stall a frame. */
const MAX_SWEEP_PASSES = 12;
/** Ticks after launch during which the shooter cannot be hit by its own shot. */
const OWNER_IMMUNE_TICKS = 5;
/** Numerical slack for the sweep maths. */
const EPS = 1e-9;
/** Vanilla's arrow gravity, 0.05 blocks/tick^2, in blocks/s^2. */
const ARROW_GRAVITY = 0.05 * TICKS_PER_SECOND * TICKS_PER_SECOND;
/** Vanilla's thrown-item gravity, 0.03 blocks/tick^2. */
const THROWN_GRAVITY = 0.03 * TICKS_PER_SECOND * TICKS_PER_SECOND;
/** Llama spit is heavier than a snowball. */
const SPIT_GRAVITY = 0.06 * TICKS_PER_SECOND * TICKS_PER_SECOND;
/**
 * Magnitude at or above which a caller's direction vector is read as blocks
 * per **second**; between `DIR_LIMIT` and this it is read as blocks per
 * **tick**; below `DIR_LIMIT` it is a bare unit direction and the type's own
 * muzzle velocity is used. Callers in this project genuinely mix all three.
 */
const SECONDS_LIMIT = 5;
const DIR_LIMIT = 1.35;

/** Fallback RNG for anything that has no seeded stream of its own. */
const FALLBACK_RNG = new RNG(0x5eed1e);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget positional sound; the audio engine is optional. */
function playAt(world, name, x, y, z, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || typeof a.playAt !== 'function') return;
  try { a.playAt(name, x, y, z, volume, pitch); } catch { /* optional */ }
}

/** Fire-and-forget particle burst; the particle system is optional. */
function particles(type, x, y, z, opts) {
  const p = Game.particles;
  if (!p || typeof p.spawn !== 'function') return;
  try { p.spawn(type, x, y, z, opts || {}); } catch { /* optional */ }
}

/** The RNG a projectile should use: its owner's, else the world's, else ours. */
function rngOf(host) {
  if (host && host.rng && typeof host.rng.next === 'function') return host.rng;
  if (host && host.world && host.world.rng && typeof host.world.rng.next === 'function') return host.world.rng;
  return FALLBACK_RNG;
}

/** Eye-height Y of any entity, players included. */
const eyeY = (e) => e.y + (e.eyeHeight !== undefined ? e.eyeHeight : (e.height || 1) * 0.85);
/** Vertical centre of an entity. */
const centreY = (e) => e.y + (e.height || 1) * 0.5;

/** True when this entity is a player (or behaves like one). */
const isPlayerLike = (e) => !!(e && (e.isPlayer || e.type === 'player'));

/** Fills `out` with an entity's bounding box, tolerating odd entities. */
function entityAabb(e, out) {
  if (e && typeof e.aabb === 'function') {
    try { return e.aabb(out); } catch { /* fall through */ }
  }
  const w = (e && e.width) || 0.6, h = (e && e.height) || 1.8;
  return out.set(e.x - w / 2, e.y, e.z - w / 2, e.x + w / 2, e.y + h, e.z + w / 2);
}

/** Item stack constructor that never throws on an unknown name. */
function itemStack(name, count = 1, extra = null) {
  if (!name) return null;
  try {
    if (!itemExists(name)) return mkStack('stick', count, extra);
    return mkStack(name, count, extra);
  } catch { return { item: name, count, damage: 0 }; }
}

/** Drops a loose stack through itementity.js, when that module has landed. */
function dropStack(world, x, y, z, s, vx = 0, vy = 2, vz = 0) {
  if (!world || isEmpty(s)) return null;
  const it = MOD.itementity;
  if (!it || typeof it.dropItem !== 'function') return null;
  try { return it.dropItem(world, x, y, z, s, vx, vy, vz); } catch { return null; }
}

/** Spawns experience orbs through itementity.js. */
function dropXP(world, x, y, z, amount) {
  if (!world || !(amount > 0)) return;
  const it = MOD.itementity;
  if (!it || typeof it.dropXP !== 'function') return;
  try { it.dropXP(world, x, y, z, amount | 0); } catch { /* optional */ }
}

/** Creates a mob through mobs.js and adds it to the world. */
function spawnMob(world, name, x, y, z, opts) {
  const m = MOD.mobs;
  if (!world || !m || typeof m.createMob !== 'function') return null;
  try {
    const mob = m.createMob(name, world, x, y, z, opts || {});
    if (mob && world.entitiesById && !world.entitiesById.has(mob.id)) world.addEntity(mob);
    return mob;
  } catch { return null; }
}

/** Hands a stack to a player, dropping whatever will not fit. */
function giveTo(entity, s) {
  if (!entity || isEmpty(s)) return;
  let left = s;
  if (typeof entity.giveItem === 'function') {
    try { left = entity.giveItem(s); } catch { left = s; }
  }
  if (!isEmpty(left)) dropStack(entity.world, entity.x, entity.y + 0.5, entity.z, left, 0, 1, 0);
}

/**
 * A minimal definition object carrying the deflect hook. It is shaped enough
 * like a mob definition that a renderer reading `def.model` or `def.category`
 * still gets something sane.
 */
function deflectDef(type) {
  return { name: type, display: type, category: 'projectile', model: 'item', skin: 'item', onHurt: deflectHook };
}

/**
 * `def.onHurt` hook shared by everything deflectable. combat.damageEntity
 * consults it before applying damage, so a punched fireball turns around
 * instead of quietly dying. Returning false vetoes the damage itself.
 */
function deflectHook(self, amount, src) {
  const by = src && (src.entity || src.direct);
  deflect(self, by && by !== self ? by : null);
  return false;
}

/** True when mobs (and mob projectiles) may rearrange this world's blocks. */
function griefingAllowed(world) {
  return !world || !world.gameRules || world.gameRules.mobGriefing !== false;
}

/** 0..3 difficulty of the world, defaulting to whatever the session is on. */
function difficultyId(world) {
  const d = (world && world.difficulty !== undefined) ? world.difficulty : Game.difficulty;
  return typeof d === 'number' ? d : DIFFICULTY.NORMAL;
}

/** Enchantment level on a stack, never throwing when the stack is odd. */
function ench(stackOrNull, name) {
  if (!stackOrNull) return 0;
  try { return getEnchant(stackOrNull, name) | 0; } catch { return 0; }
}

/** Whatever the shooter is holding, used to read a thrown item's enchants. */
function heldOf(e) {
  if (!e) return null;
  try {
    if (typeof e.getHeldItem === 'function') return e.getHeldItem();
  } catch { /* optional */ }
  return null;
}

// ---------------------------------------------------------------------------
// Swept collision
//
// Everything is a Minkowski sweep: the projectile's half-extents are added to
// the target box and the projectile is treated as the single point at its own
// centre. `_slab` reports which face was entered, for the stick/bounce maths.
// ---------------------------------------------------------------------------

const _slab = { axis: -1, sgn: 0 };
const _entBox = new AABB();
const _queryBox = new AABB();
const _hitBlock = { t: 0, axis: -1, sgn: 0, x: 0, y: 0, z: 0, id: 0, meta: 0, face: FACE_UP };

/** Face index for an entered slab: axis 0/1/2 with sign -1 (low) or +1 (high). */
function faceFor(axis, sgn) {
  if (axis === 0) return sgn > 0 ? FACE_EAST : FACE_WEST;
  if (axis === 1) return sgn > 0 ? FACE_UP : FACE_DOWN;
  if (axis === 2) return sgn > 0 ? FACE_SOUTH : FACE_NORTH;
  return FACE_UP;
}

/**
 * Slab sweep of a point moving by (dx,dy,dz) against `b` grown by (ex,ey,ez).
 * @returns {number} entry time in [0, maxT], or -1 when there is no hit
 */
function sweepAgainst(ox, oy, oz, dx, dy, dz, b, ex, ey, ez, maxT) {
  let tmin = 0, tmax = maxT, axis = -1, sgn = 0;

  // X slab
  let lo = b.x0 - ex, hi = b.x1 + ex;
  if (dx > -EPS && dx < EPS) { if (ox < lo || ox > hi) return -1; }
  else {
    const inv = 1 / dx;
    let t0 = (lo - ox) * inv, t1 = (hi - ox) * inv, s = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; s = 1; }
    if (t0 > tmin) { tmin = t0; axis = 0; sgn = s; }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }
  // Y slab
  lo = b.y0 - ey; hi = b.y1 + ey;
  if (dy > -EPS && dy < EPS) { if (oy < lo || oy > hi) return -1; }
  else {
    const inv = 1 / dy;
    let t0 = (lo - oy) * inv, t1 = (hi - oy) * inv, s = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; s = 1; }
    if (t0 > tmin) { tmin = t0; axis = 1; sgn = s; }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }
  // Z slab
  lo = b.z0 - ez; hi = b.z1 + ez;
  if (dz > -EPS && dz < EPS) { if (oz < lo || oz > hi) return -1; }
  else {
    const inv = 1 / dz;
    let t0 = (lo - oz) * inv, t1 = (hi - oz) * inv, s = -1;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; s = 1; }
    if (t0 > tmin) { tmin = t0; axis = 2; sgn = s; }
    if (t1 < tmax) tmax = t1;
    if (tmin > tmax) return -1;
  }

  if (tmin < 0 || tmin > maxT) return -1;
  _slab.axis = axis; _slab.sgn = sgn;
  return tmin;
}

/** True when a block takes part in projectile collision (same rule as move()). */
function blockStops(def) {
  return !!def && def.solid && def.collision !== 'none' && !def.liquid;
}

/**
 * Nearest block hit along a sweep. Returns the shared `_hitBlock` record (so
 * callers must consume it before the next call) or null.
 */
function sweepBlocks(world, ox, oy, oz, dx, dy, dz, ex, ey, ez, maxT) {
  if (!world) return null;
  let best = -1;
  let bx = 0, by = 0, bz = 0, bid = 0, bmeta = 0, baxis = -1, bsgn = 0;

  let x0 = Math.floor(Math.min(ox, ox + dx * maxT) - ex - 0.001);
  let x1 = Math.floor(Math.max(ox, ox + dx * maxT) + ex + 0.001);
  let y0 = Math.floor(Math.min(oy, oy + dy * maxT) - ey - 0.001);
  let y1 = Math.floor(Math.max(oy, oy + dy * maxT) + ey + 0.001);
  let z0 = Math.floor(Math.min(oz, oz + dz * maxT) - ez - 0.001);
  let z1 = Math.floor(Math.max(oz, oz + dz * maxT) + ez + 0.001);
  // A wild velocity must never turn into a million-block scan.
  if (x1 - x0 > 8) x1 = x0 + 8;
  if (y1 - y0 > 8) y1 = y0 + 8;
  if (z1 - z0 > 8) z1 = z0 + 8;
  if (y0 < 0) y0 = 0;
  if (y1 > WORLD_HEIGHT - 1) y1 = WORLD_HEIGHT - 1;

  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const v = world.getRaw(x, y, z);
        const id = v & ID_MASK;
        if (id === 0) continue;
        const def = getBlock(id);
        if (!blockStops(def)) continue;
        const meta = (v >>> 12) & 15;
        let boxes;
        try { boxes = blockBoxes(id, meta, x, y, z); } catch { boxes = null; }
        if (!boxes || !boxes.length) continue;
        for (let i = 0; i < boxes.length; i++) {
          const t = sweepAgainst(ox, oy, oz, dx, dy, dz, boxes[i], ex, ey, ez,
            best < 0 ? maxT : best);
          if (t < 0) continue;
          if (best < 0 || t < best) {
            best = t; bx = x; by = y; bz = z; bid = id; bmeta = meta;
            baxis = _slab.axis; bsgn = _slab.sgn;
          }
        }
      }
    }
  }
  if (best < 0) return null;
  _hitBlock.t = best; _hitBlock.axis = baxis; _hitBlock.sgn = bsgn;
  _hitBlock.x = bx; _hitBlock.y = by; _hitBlock.z = bz;
  _hitBlock.id = bid; _hitBlock.meta = bmeta;
  _hitBlock.face = faceFor(baxis, bsgn);
  return _hitBlock;
}

/**
 * Nearest entity hit along a sweep.
 * @returns {{entity:object, t:number}|null}
 */
function sweepEntities(world, self, ox, oy, oz, dx, dy, dz, ex, ey, ez, maxT, skip) {
  if (!world || typeof world.entitiesInAABB !== 'function') return null;
  const pad = 0.1;
  _queryBox.set(
    Math.min(ox, ox + dx * maxT) - ex - pad, Math.min(oy, oy + dy * maxT) - ey - pad,
    Math.min(oz, oz + dz * maxT) - ez - pad, Math.max(ox, ox + dx * maxT) + ex + pad,
    Math.max(oy, oy + dy * maxT) + ey + pad, Math.max(oz, oz + dz * maxT) + ez + pad,
  );
  let list;
  try { list = world.entitiesInAABB(_queryBox, (e) => self.canHitEntity(e)); }
  catch { return null; }
  if (!list || !list.length) return null;

  let best = null, bestT = maxT;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (skip && skip.has(e.id)) continue;
    const b = entityAabb(e, _entBox);
    // The extra slack matches vanilla's forgiving arrow hitboxes.
    const t = sweepAgainst(ox, oy, oz, dx, dy, dz, b, ex + 0.08, ey + 0.08, ez + 0.08, bestT);
    if (t < 0) continue;
    if (t <= bestT) { bestT = t; best = e; }
  }
  return best ? { entity: best, t: bestT } : null;
}

// ===========================================================================
// Projectile
// ===========================================================================

/**
 * The flight half of every projectile: ballistics, drag, the swept collision
 * pass and the rotation the renderer reads. Subclasses override `onBlockHit`,
 * `onEntityHit` and `tickLogic`.
 */
export class Projectile extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z spawn point (centre-ish)
   * @param {object} [opts] spawn options, forwarded from `spawnProjectile`
   */
  constructor(world, x = 0, y = 0, z = 0, opts = {}) {
    super(world, x, y, z);
    const o = opts || {};
    this.type = 'projectile';
    this.projectile = true;

    this.width = 0.25;
    this.height = 0.25;
    this.eyeHeight = 0.125;

    // The base entity mover would tunnel at these speeds; we sweep by hand.
    this.noClip = true;
    this.pushable = false;
    this.gravity = THROWN_GRAVITY;
    this.noGravity = false;
    this.dragPerTick = 0.99;         // horizontal + vertical air resistance
    this.waterDragPerTick = 0.8;
    this.accel = 0;                  // self-propulsion along `dir`, blocks/s^2
    this.dirX = 0; this.dirY = 0; this.dirZ = 1;
    this.launchSpeed = 1;

    this.owner = o.owner || o.shooter || null;
    this.shooter = this.owner;
    this.ownerId = this.owner ? this.owner.id : (o.ownerId !== undefined ? o.ownerId : null);
    this.ownerImmuneTicks = OWNER_IMMUNE_TICKS;

    this.hitsEntities = true;
    this.hitsBlocks = true;
    this.deflectable = false;
    this.canSwatProjectiles = false;
    this.inGround = false;
    this.stuck = false;
    this.shakeTicks = 0;
    this.life = 0;
    this.maxLife = 1200;             // 60 s, the vanilla arrow lifetime
    this.groundLife = 0;
    this.stuckIn = { x: 0, y: 0, z: 0, id: 0 };

    this.damage = o.damage !== undefined ? o.damage : 0;
    this.knockbackStrength = o.knockback !== undefined ? o.knockback : 0;
    this.pierce = (o.pierce !== undefined ? o.pierce : o.piercing) | 0;
    this.piercedIds = null;
    this.itemName = typeof o.item === 'string' ? o.item : null;
    this.damageType = 'thrown';

    this.rng = rngOf(this.owner || world);
    this.health = 1; this.maxHealth = 1;
    this.invulnerable = false;
    this.canPickUpLoot = false;
    this._stopped = false;

    // Render hints. entityrenderer.js resolves `model`/`skin` first and falls
    // back to the type name, which would pick nonsense for 'wither_skull'.
    this.model = 'item';
    this.skin = 'item';
    this.billboard = true;
    this.renderItem = this.itemName || 'arrow';
    this.renderScale = 0.6;
  }

  // ---- setup -------------------------------------------------------------

  /** Records who fired this, so it cannot immediately hit them. */
  setOwner(e) {
    this.owner = e || null;
    // combat.js reads and writes `shooter`; keep the two names in step.
    this.shooter = this.owner;
    this.ownerId = e ? e.id : null;
    if (e && e.rng && typeof e.rng.next === 'function') this.rng = e.rng;
    return this;
  }

  /**
   * Points the projectile down (nx, ny, nz) at `speed` blocks/second and
   * snapshots the launch speed used for velocity-scaled damage.
   */
  launch(nx, ny, nz, speed) {
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    this.dirX = nx / len; this.dirY = ny / len; this.dirZ = nz / len;
    this.vx = this.dirX * speed;
    this.vy = this.dirY * speed;
    this.vz = this.dirZ * speed;
    this.launchSpeed = Math.max(speed, 1e-3);
    this.faceVelocity();
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    return this;
  }

  /** Aims yaw/pitch along the current velocity so the model points forward. */
  faceVelocity() {
    const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz);
    if (sp < 1e-4) return;
    this.dirX = this.vx / sp; this.dirY = this.vy / sp; this.dirZ = this.vz / sp;
    this.yaw = Math.atan2(-this.vx, this.vz);
    this.pitch = -Math.asin(clamp(this.vy / sp, -1, 1));
    this.headYaw = this.yaw;
    this.headPitch = this.pitch;
  }

  /** Current speed in blocks per tick, the unit vanilla's damage maths uses. */
  speedPerTick() {
    return Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz) / TICKS_PER_SECOND;
  }

  // ---- filtering ---------------------------------------------------------

  /** True when this projectile is allowed to collide with `e`. */
  canHitEntity(e) {
    if (!e || e === this || e.removed) return false;
    if (e.noProjectileHits) return false;
    // Arrows knock ghast fireballs and shulker bullets out of the air; nothing
    // else collides with another projectile.
    if (e.projectile) return !!(this.canSwatProjectiles && e.deflectable);
    if (e.type === 'item' || e.type === 'item_entity' || e.type === 'xp_orb' ||
        e.type === 'experience_orb' || e.type === 'area_effect_cloud' ||
        e.type === 'falling_block') return false;
    if (e.gameMode === 'spectator') return false;
    if (typeof e.health !== 'number' && !e.isVehicle) return false;
    if (e.dead || (typeof e.health === 'number' && e.health <= 0)) return false;
    if (e === this.owner && this.ownerImmuneTicks > 0) return false;
    if (e.id !== undefined && e.id === this.ownerId && this.ownerImmuneTicks > 0) return false;
    // A shooter riding something should not shoot its own mount in the back.
    if (this.owner && (e === this.owner.vehicle || e.rider === this.owner) &&
        this.ownerImmuneTicks > 0) return false;
    return true;
  }

  // ---- per-frame ---------------------------------------------------------

  /** @override flight, drag and the swept collision pass. */
  update(dt) {
    if (this.removed) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;

    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.prevYaw = this.yaw; this.prevPitch = this.pitch;
    this._updatedSinceTick = true;

    try { this.updateEnvironment(); } catch { /* optional */ }

    if (this.inGround) { this.groundUpdate(dt); return; }

    this.accelerate(dt);
    this._stopped = false;
    this.integrate(dt);
    if (!this.removed && !this.inGround) {
      this.faceVelocity();
      this.afterMove(dt);
    }
  }

  /** Gravity, self-propulsion and medium drag for one frame. */
  accelerate(dt) {
    if (this.accel > 0) {
      this.vx += this.dirX * this.accel * dt;
      this.vy += this.dirY * this.accel * dt;
      this.vz += this.dirZ * this.accel * dt;
    }
    if (!this.noGravity && this.gravity > 0) this.vy -= this.gravity * dt;
    const perTick = this.inWater ? this.waterDragPerTick : this.dragPerTick;
    if (perTick < 1) {
      const m = Math.pow(perTick, dt * TICKS_PER_SECOND);
      this.vx *= m; this.vy *= m; this.vz *= m;
    }
  }

  /** Splits the frame's movement into short, tunnel-proof collision passes. */
  integrate(dt) {
    let remaining = dt;
    let passes = 0;
    while (remaining > 1e-7 && passes++ < MAX_SWEEP_PASSES) {
      if (this.removed || this.inGround || this._stopped) break;
      const v = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz);
      if (v < 1e-5) break;
      const step = Math.min(remaining, MAX_SWEEP_STEP / v);
      const used = this.collideStep(this.vx * step, this.vy * step, this.vz * step);
      remaining -= step * Math.max(used, 0);
      if (used >= 0.999) continue;
      if (this._stopped || this.removed || this.inGround) break;
    }
  }

  /**
   * One swept pass. Moves as far as it can, then dispatches the nearer of the
   * block and entity hits.
   * @returns {number} fraction of the requested move actually travelled
   */
  collideStep(dx, dy, dz) {
    const world = this.world;
    if (!world) { this.x += dx; this.y += dy; this.z += dz; return 1; }

    const ex = this.width * 0.5, ey = this.height * 0.5, ez = this.width * 0.5;
    const ox = this.x, oy = this.y + ey, oz = this.z;

    let entHit = null;
    if (this.hitsEntities) {
      entHit = sweepEntities(world, this, ox, oy, oz, dx, dy, dz, ex, ey, ez, 1, this.piercedIds);
    }
    let blkT = -1, blkFace = FACE_UP, blkX = 0, blkY = 0, blkZ = 0, blkId = 0, blkMeta = 0;
    if (this.hitsBlocks) {
      const h = sweepBlocks(world, ox, oy, oz, dx, dy, dz, ex, ey, ez, 1);
      if (h) {
        blkT = h.t; blkFace = h.face;
        blkX = h.x; blkY = h.y; blkZ = h.z; blkId = h.id; blkMeta = h.meta;
      }
    }

    let t = 1;
    let kind = 0;                                  // 0 none, 1 entity, 2 block
    if (entHit && (blkT < 0 || entHit.t <= blkT)) { t = entHit.t; kind = 1; }
    else if (blkT >= 0) { t = blkT; kind = 2; }

    this.x += dx * t; this.y += dy * t; this.z += dz * t;

    if (kind === 1) {
      const target = entHit.entity;
      if (this.pierce > 0) {
        if (!this.piercedIds) this.piercedIds = new Set();
        this.piercedIds.add(target.id);
      }
      try { this.onEntityHit(target); } catch (e) { console.error('[projectile] entity hit failed', this.type, e); }
      if (this.pierce > 0 && !this.removed) {
        this.pierce--;
        // Nudge past the victim so the same box is not re-entered at t = 0.
        this.x += dx * 0.02; this.y += dy * 0.02; this.z += dz * 0.02;
      } else if (!this.removed && !this.inGround) {
        this._stopped = true;
      }
      return t;
    }

    if (kind === 2) {
      const hit = {
        x: blkX, y: blkY, z: blkZ, id: blkId, meta: blkMeta, face: blkFace,
        px: this.x, py: this.y + ey, pz: this.z,
      };
      try { this.onBlockHit(hit); } catch (e) { console.error('[projectile] block hit failed', this.type, e); }
      this._stopped = true;
      return t;
    }
    return 1;
  }

  /** Hook for trails and steering, run after a clean (uninterrupted) move. */
  afterMove(dt) { /* subclasses */ }

  /** Hook for a projectile that is stuck in a block; default is to sit still. */
  groundUpdate(dt) { /* subclasses */ }

  // ---- per-tick ----------------------------------------------------------

  /** @override 20 Hz logic. Deliberately far lighter than LivingEntity's. */
  tick() {
    if (this.removed) return;
    this.age++;
    this.life++;
    if (this.ownerImmuneTicks > 0) this.ownerImmuneTicks--;

    // If nothing drove update() this tick (an unrendered world), run physics.
    if (!this._updatedSinceTick) this.update(1 / TICKS_PER_SECOND);
    this._updatedSinceTick = false;

    if (this.inGround) this.groundLife++;
    if (this.shakeTicks > 0) this.shakeTicks--;
    // A projectile restored from a save has an id but no owner reference yet.
    if (!this.owner && this.ownerId != null && (this.age & 15) === 0) this.resolveOwner();

    try { this.tickLogic(); } catch (e) { console.error('[projectile] tick failed', this.type, e); }

    if (this.removed) return;
    if (this.y < -32 || this.y > WORLD_HEIGHT + 96) { this.discard(); return; }
    if (this.life > this.maxLife) this.expire();
  }

  /** Per-type 20 Hz behaviour. */
  tickLogic() { /* subclasses */ }

  /** What happens when `maxLife` runs out. Most projectiles just vanish. */
  expire() { this.discard(); }

  // ---- impact ------------------------------------------------------------

  /**
   * Default block behaviour: stop dead where the sweep put us and remember the
   * block, so a projectile that sticks knows when its perch is broken.
   */
  onBlockHit(hit) {
    const dir = FACE_DIRS[hit.face] || FACE_DIRS[FACE_UP];
    // Back off a hair along the face normal so the model is not inside stone.
    this.x += dir[0] * 0.01;
    this.y += dir[1] * 0.01;
    this.z += dir[2] * 0.01;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.inGround = true;
    this.stuck = true;
    this.groundLife = 0;
    this.shakeTicks = 7;
    this.stuckIn.x = hit.x; this.stuckIn.y = hit.y; this.stuckIn.z = hit.z;
    this.stuckIn.id = hit.id;
    this.onImpact(hit, null);
  }

  /** Default entity behaviour: deal the damage, then stop. */
  onEntityHit(target) {
    this.dealDamage(target, this.damage);
    this.onImpact(null, target);
  }

  /**
   * Shared "and then what" hook. `hit` is a block hit record or null; `target`
   * is the entity hit or null.
   */
  onImpact(hit, target) { /* subclasses */ }

  /** The damage source this projectile carries. */
  makeSource(extra) {
    return damageSource(this.damageType, this.owner || null, this, Object.assign({
      projectile: true, noKnockback: true,
    }, extra || null));
  }

  /** Applies damage plus this projectile's own knockback along its flight. */
  dealDamage(target, amount, extra) {
    if (!target || !(amount > 0)) return false;
    const src = this.makeSource(extra);
    let ok = false;
    try { ok = damageEntity(target, amount, src); } catch { ok = false; }
    if (ok) this.pushTarget(target, this.knockbackStrength);
    return ok;
  }

  /** Shoves `target` along the projectile's direction of travel. */
  pushTarget(target, strength) {
    if (!target || !(strength > 0)) return;
    const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz);
    let nx = this.dirX, nz = this.dirZ;
    if (sp > 1e-4) { nx = this.vx / sp; nz = this.vz / sp; }
    const flat = Math.hypot(nx, nz) || 1;
    nx /= flat; nz /= flat;
    try {
      applyKnockback(target, target.x - nx, centreY(target), target.z - nz, strength);
    } catch { /* optional */ }
  }

  /** Removes the projectile from the world. */
  discard() {
    if (this.removed) return;
    this.remove();
  }

  // ---- persistence -------------------------------------------------------

  /** @override */
  serialize() {
    const o = super.serialize();
    o.item = this.itemName;
    o.damage = this.damage;
    o.knockback = this.knockbackStrength;
    o.pierce = this.pierce;
    o.inGround = this.inGround;
    o.stuckIn = { x: this.stuckIn.x, y: this.stuckIn.y, z: this.stuckIn.z, id: this.stuckIn.id };
    o.life = this.life;
    o.ownerId = this.ownerId;
    o.launchSpeed = this.launchSpeed;
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.item !== undefined) { this.itemName = obj.item; this.renderItem = obj.item || this.renderItem; }
    if (obj.damage !== undefined) this.damage = obj.damage;
    if (obj.inGround !== undefined) { this.inGround = !!obj.inGround; this.stuck = this.inGround; }
    if (obj.life !== undefined) this.life = obj.life;
    if (obj.ownerId !== undefined) this.ownerId = obj.ownerId;
    if (obj.launchSpeed) this.launchSpeed = obj.launchSpeed;
    if (obj.pierce !== undefined) this.pierce = obj.pierce | 0;
    if (obj.knockback !== undefined) this.knockbackStrength = obj.knockback;
    if (obj.stuckIn) {
      this.stuckIn.x = obj.stuckIn.x; this.stuckIn.y = obj.stuckIn.y;
      this.stuckIn.z = obj.stuckIn.z; this.stuckIn.id = obj.stuckIn.id;
    }
    this.faceVelocity();
    return this;
  }

  /**
   * @override the saved record doubles as the constructor's options, so a
   * tipped arrow reloads with its potion and a lingering bottle with its form.
   */
  static deserialize(obj, world) {
    const o = obj || {};
    const e = new this(world, o.x || 0, o.y || 0, o.z || 0, o);
    e.load(o);
    return e;
  }

  /** Re-links `owner` from a saved id, once the world has all its entities. */
  resolveOwner() {
    if (this.owner || this.ownerId == null || !this.world) return this.owner;
    const e = this.world.getEntity ? this.world.getEntity(this.ownerId) : null;
    if (e) this.owner = e;
    return this.owner;
  }
}

// ===========================================================================
// Arrows
// ===========================================================================

/**
 * Everything that sticks in the wall and can be picked back up: arrows,
 * spectral arrows, tipped arrows and the trident.
 */
export class AbstractArrow extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'arrow';
    this.damageType = 'arrow';
    this.width = 0.5; this.height = 0.5; this.eyeHeight = 0.25;
    this.gravity = ARROW_GRAVITY;
    this.dragPerTick = 0.99;
    this.waterDragPerTick = 0.6;
    this.maxLife = 1200;

    /** Damage per block-per-tick of speed. Vanilla's `baseDamage`, 2.0. */
    this.damagePerBlock = 2;
    this.critical = !!o.critical;
    this.knockbackStrength = 0.4 + (o.punch !== undefined ? o.punch : o.knockback || 0) * 0.6;
    this.punch = (o.punch !== undefined ? o.punch : o.knockback) | 0;
    this.flame = !!o.flame;
    this.pierce = (o.pierce !== undefined ? o.pierce : o.piercing) | 0;
    this.pickup = o.pickup || (o.infinity ? 'creative' : 'allowed');
    this.canSwatProjectiles = true;
    // `payload`, not `effects`: Entity.effects is the *carrier's own* status
    // effect map, and shadowing it would break effects.js.
    this.itemName = o.item || 'arrow';
    this.renderItem = this.itemName;
    this.payload = normalizeEffects(o.effects) || effectsFromItem(this.itemName, o.potion, 'tipped_arrow');
    this.potionColor = potionColorFor(this.itemName, o.potion);
    if (this.flame) this.fireTicks = Math.max(this.fireTicks | 0, 100);
  }

  /**
   * Converts a caller's `damage` into "damage per block of velocity".
   * combat.js hands over an already speed-scaled number *and* a `baseDamage`
   * field; mobs.js and ai.js hand over vanilla's raw base. The presence of
   * `baseDamage` is what tells the two apart.
   */
  configureDamage(opts, launchSpeed) {
    const o = opts || {};
    const perTick = Math.max(launchSpeed / TICKS_PER_SECOND, 1e-3);
    if (o.baseDamage !== undefined && o.damage !== undefined) {
      this.damagePerBlock = o.damage / perTick;
    } else if (o.damage !== undefined) {
      this.damagePerBlock = o.damage;
    }
    this.damage = this.damagePerBlock * perTick;
  }

  /** Vanilla's `ceil(speed * baseDamage)`, plus the critical bonus. */
  computeHitDamage() {
    const speed = Math.max(this.speedPerTick(), 0.05);
    let dmg = Math.ceil(clamp(speed * this.damagePerBlock, 0, 200));
    if (dmg < 1) dmg = 1;
    if (this.critical) dmg += this.rng.int(Math.floor(dmg / 2) + 2);
    return dmg;
  }

  /** @override arrows leave a trail and fizz out in water. */
  afterMove(dt) {
    if (this.critical && (this.age & 1) === 0) {
      particles('crit', this.x, this.y + 0.1, this.z, { count: 1, spread: 0.05, life: 0.35 });
    }
    if (this.fireTicks > 0 && !this.inWater) {
      particles('flame', this.x, this.y + 0.1, this.z, { count: 1, spread: 0.05, life: 0.3 });
    }
    if (this.inWater) {
      this.critical = false;
      if (this.fireTicks > 0) this.fireTicks = 0;
      particles('bubble', this.x, this.y, this.z, { count: 1, spread: 0.1 });
    }
  }

  /** @override a stuck arrow drops out when its block is broken. */
  groundUpdate(dt) {
    const w = this.world;
    if (!w) return;
    const s = this.stuckIn;
    if (w.getBlock(s.x, s.y, s.z) !== s.id) {
      this.inGround = false;
      this.stuck = false;
      this.vx = 0; this.vy = -0.5; this.vz = 0;
      this.groundLife = 0;
    }
  }

  /** @override */
  tickLogic() {
    if (this.inGround) {
      this.tryPickup();
      // Vanilla keeps a landed arrow for a minute, then tidies it away.
      if (this.groundLife > 1200) this.discard();
      return;
    }
    if (this.inWater && this.critical) this.critical = false;
  }

  /** @override sticking in the block, plus the wooden 'thunk'. */
  onBlockHit(hit) {
    super.onBlockHit(hit);
    playAt(this.world, 'arrow_hit', this.x, this.y, this.z, 0.8,
      1.05 + this.rng.next() * 0.25);
    this.critical = false;
    // Flame arrows light what they land on.
    if (this.fireTicks > 0) this.igniteAt(hit);
  }

  /** Lights a fire on the face the arrow struck, when the world allows it. */
  igniteAt(hit) {
    const w = this.world;
    if (!w || !griefingAllowed(w)) return;
    const fire = blockByName('fire');
    if (!fire) return;
    const dir = FACE_DIRS[hit.face] || FACE_DIRS[FACE_UP];
    const fx = hit.x + dir[0], fy = hit.y + dir[1], fz = hit.z + dir[2];
    if (fy < 0 || fy >= WORLD_HEIGHT) return;
    try {
      if (w.isAir(fx, fy, fz)) w.setBlock(fx, fy, fz, fire.id, 0, 3);
    } catch { /* optional */ }
  }

  /** @override the full arrow impact: damage, fire, effects, piercing. */
  onEntityHit(target) {
    // A fireball or shulker bullet is swatted out of the air, not wounded.
    if (target.projectile) {
      deflect(target, this.owner || this);
      this.discard();
      return;
    }
    const dmg = this.computeHitDamage() + this.bonusDamageAgainst(target);
    const src = this.makeSource({ bypassCooldown: this.pierce > 0 });
    let ok = false;
    try { ok = damageEntity(target, dmg, src); } catch { ok = false; }

    if (ok || target.invulnerable) {
      if (this.fireTicks > 0) {
        try { setOnFire(target, 5); } catch { /* optional */ }
      }
      this.applyEffectsTo(target);
      this.pushTarget(target, this.knockbackStrength);
      this.onArrowHitEntity(target, dmg);
      if (isPlayerLike(this.owner)) {
        playAt(this.world, 'arrow_hit_player', this.owner.x, this.owner.y, this.owner.z, 0.5, 1.2);
      }
      playAt(this.world, 'arrow_hit', this.x, this.y, this.z, 0.6, 1.3);
    }

    this.critical = false;
    if (this.pierce <= 0) this.afterSingleHit(target, ok);
  }

  /** Per-subclass extra damage (impaling, and so on). */
  bonusDamageAgainst(target) { return 0; }
  /** Per-subclass follow-up (glowing, channeling). */
  onArrowHitEntity(target, dmg) { /* subclasses */ }

  /** What a non-piercing arrow does after landing its one hit. */
  afterSingleHit(target, dealt) { this.discard(); }

  /** Applies the tipped-potion payload. */
  applyEffectsTo(target) {
    const list = this.payload;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      try { addEffect(target, e.name, Math.max(1, e.ticks | 0), e.level | 0); } catch { /* optional */ }
    }
  }

  /** Lets a nearby player scoop a landed arrow back up. */
  tryPickup() {
    if (this.pickup === 'disallowed' || !this.world) return;
    let players;
    try { players = this.world.getPlayers ? this.world.getPlayers() : []; } catch { players = []; }
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p || p.removed || p.dead) continue;
      if (this.distanceToSq(p.x, p.y + 0.5, p.z) > 2.25) continue;
      const mode = p.gameMode || Game.mode;
      const creative = mode === 'creative' || mode === 'spectator';
      if (this.pickup === 'creative' && !creative) continue;
      if (!creative) {
        const s = itemStack(this.pickupItem(), 1);
        if (!s) continue;
        giveTo(p, s);
      }
      playAt(this.world, 'item_pickup', p.x, p.y, p.z, 0.25, 1.6 + this.rng.next() * 0.3);
      Game.emit('itempickup', { item: this.pickupItem(), count: 1 });
      this.discard();
      return;
    }
  }

  /** The item name a pickup should hand over. */
  pickupItem() { return this.itemName || 'arrow'; }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.critical = this.critical;
    o.pickup = this.pickup;
    o.punch = this.punch;
    o.flame = this.flame;
    o.damagePerBlock = this.damagePerBlock;
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.critical !== undefined) this.critical = !!obj.critical;
    if (obj.pickup !== undefined) this.pickup = obj.pickup;
    if (obj.damagePerBlock !== undefined) this.damagePerBlock = obj.damagePerBlock;
    return this;
  }
}

/** A plain, spectral or tipped arrow. */
export class ArrowEntity extends AbstractArrow {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = o.spectral ? 'spectral_arrow' : (this.payload && this.payload.length ? 'tipped_arrow' : 'arrow');
    this.spectral = !!o.spectral;
    this.glowTicks = o.glowTicks !== undefined ? o.glowTicks : 200;
    if (this.spectral && this.itemName === 'arrow') { this.itemName = 'spectral_arrow'; this.renderItem = 'spectral_arrow'; }
  }

  /** @override spectral arrows also mark the victim. */
  onArrowHitEntity(target, dmg) {
    if (!this.spectral) return;
    try { addEffect(target, 'glowing', this.glowTicks, 0); } catch { /* optional */ }
    particles('magic', target.x, centreY(target), target.z, { count: 6, color: 0xffffbb, spread: 0.4 });
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.spectral = this.spectral;
    return o;
  }

  /** @override tipped arrows trail their potion colour. */
  afterMove(dt) {
    super.afterMove(dt);
    if (this.potionColor != null && (this.age & 1) === 0) {
      particles('magic', this.x, this.y + 0.1, this.z,
        { count: 1, color: this.potionColor, spread: 0.06, life: 0.4 });
    }
  }
}

/** The trident: loyalty, channeling, impaling and riptide. */
export class TridentEntity extends AbstractArrow {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'trident';
    this.damageType = 'trident';
    this.width = 0.5; this.height = 0.5;
    this.damagePerBlock = 8 / 2.5;             // 8 damage at the 2.5 b/t throw
    this.itemName = o.item || 'trident';
    this.renderItem = 'trident';
    this.renderScale = 1;
    this.loyalty = clamp((o.loyalty | 0), 0, 3);
    this.channeling = (o.channeling | 0) > 0;
    this.impaling = o.impaling | 0;
    this.stackData = o.stack || null;
    this.pickup = o.pickup || 'allowed';
    this.dealtDamage = false;
    this.returning = !!o.returning;
    this.knockbackStrength = 0.6;
    this.maxLife = 2400;
    if (this.returning) { this.hitsBlocks = false; this.hitsEntities = false; this.noGravity = true; }
  }

  /** @override the trident is a fixed-damage weapon, not a velocity-scaled one. */
  configureDamage(opts, launchSpeed) {
    const o = opts || {};
    const perTick = Math.max(launchSpeed / TICKS_PER_SECOND, 1e-3);
    if (o.damage !== undefined) this.damagePerBlock = o.damage / perTick;
    this.damage = this.damagePerBlock * perTick;
  }

  /** @override impaling hurts anything that lives in (or stands in) water. */
  bonusDamageAgainst(target) {
    if (!this.impaling) return 0;
    const wet = !!(target.waterMob || target.inWater ||
      (target.def && target.def.waterMob) ||
      (this.world && this.world.isRainingAt && this.world.isRainingAt(
        Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))));
    return wet ? 2.5 * this.impaling : 0;
  }

  /** @override channeling calls down lightning in a thunderstorm. */
  onArrowHitEntity(target, dmg) {
    this.dealtDamage = true;
    if (!this.channeling || !this.world) return;
    const w = this.world;
    const storming = (w.weather && w.weather.thunder > 0) || w.thundering;
    if (!storming) return;
    let sky = true;
    try { sky = w.canSeeSky(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)); } catch { sky = true; }
    if (!sky) return;
    try { lightningStrike(w, target.x, target.y, target.z, { cause: this.owner }); } catch { /* optional */ }
    playAt(w, 'trident_thunder', target.x, target.y, target.z, 4, 1);
  }

  /** @override loyalty brings it home instead of leaving it in the victim. */
  afterSingleHit(target, dealt) {
    this.dealtDamage = true;
    if (this.loyalty > 0 && this.owner && !this.owner.removed) this.startReturn();
    else this.stickIntoAir();
  }

  /** @override sticks in the block, then comes home if it is loyal. */
  onBlockHit(hit) {
    super.onBlockHit(hit);
    if (this.loyalty > 0 && this.owner && !this.owner.removed) this.startReturn();
  }

  /** Turns the trident around and flies it back to its owner. */
  startReturn() {
    this.returning = true;
    this.inGround = false;
    this.stuck = false;
    this.hitsBlocks = false;
    this.hitsEntities = false;
    this.noGravity = true;
    this.dragPerTick = 1;
    playAt(this.world, 'trident_return', this.x, this.y, this.z, 0.8, 1);
  }

  /** No loyalty: stop dead in mid-air so it can be picked up off the floor. */
  stickIntoAir() {
    this.vx *= 0.1; this.vy = -1; this.vz *= 0.1;
    this.noGravity = false;
    this.hitsBlocks = true;
    this.hitsEntities = false;
  }

  /** @override */
  tickLogic() {
    if (this.returning) {
      const o = this.owner;
      if (!o || o.removed || (o.dead && !isPlayerLike(o))) {
        // Nobody left to catch it: drop it where it is.
        dropStack(this.world, this.x, this.y, this.z, this.tridentStack(), 0, 1, 0);
        this.discard();
        return;
      }
      const tx = o.x, ty = eyeY(o) - 0.3, tz = o.z;
      const dx = tx - this.x, dy = ty - this.y, dz = tz - this.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1.2) {
        if (isPlayerLike(o)) giveTo(o, this.tridentStack());
        else dropStack(this.world, o.x, o.y + 0.5, o.z, this.tridentStack(), 0, 0.5, 0);
        playAt(this.world, 'item_pickup', o.x, o.y, o.z, 0.4, 1.4);
        this.discard();
        return;
      }
      const speed = 12 + this.loyalty * 8;
      this.vx = (dx / d) * speed;
      this.vy = (dy / d) * speed;
      this.vz = (dz / d) * speed;
      this.faceVelocity();
      particles('crit', this.x, this.y, this.z, { count: 1, spread: 0.1, life: 0.3 });
      return;
    }
    super.tickLogic();
  }

  /** The stack the trident hands back, keeping its enchantments. */
  tridentStack() {
    if (this.stackData) { try { return copyStack(this.stackData); } catch { /* fall through */ } }
    return itemStack(this.itemName || 'trident', 1);
  }

  /** @override */
  pickupItem() { return this.itemName || 'trident'; }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.loyalty = this.loyalty;
    o.channeling = this.channeling ? 1 : 0;
    o.impaling = this.impaling;
    o.returning = this.returning;
    o.dealtDamage = this.dealtDamage;
    return o;
  }
}

// ===========================================================================
// Thrown items
// ===========================================================================

/** Snowballs, eggs, pearls, bottles and potions: light, draggy, one-shot. */
export class ThrownItem extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    this.type = 'thrown_item';
    this.damageType = 'thrown';
    this.width = 0.25; this.height = 0.25; this.eyeHeight = 0.125;
    this.gravity = THROWN_GRAVITY;
    this.dragPerTick = 0.99;
    this.waterDragPerTick = 0.8;
    this.maxLife = 600;
    this.renderScale = 0.5;
  }

  /** @override thrown items burst on any contact. */
  onBlockHit(hit) {
    this.onImpact(hit, null);
    if (!this.removed) this.discard();
  }

  /** @override */
  onEntityHit(target) {
    if (this.damage > 0) this.dealDamage(target, this.damage);
    else if (this.knockbackStrength > 0) this.pushTarget(target, this.knockbackStrength);
    this.onImpact(null, target);
    if (!this.removed) this.discard();
  }
}

/** Snowball: no damage, a small shove, and three hearts to a blaze. */
export class SnowballEntity extends ThrownItem {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'snowball';
    this.damageType = 'snowball';
    this.itemName = o.item || 'snowball';
    this.renderItem = 'snowball';
    this.blazeDamage = o.blazeDamage !== undefined ? o.blazeDamage : 3;
    this.damage = o.damage !== undefined ? o.damage : 0;
    this.knockbackStrength = o.knockback !== undefined ? o.knockback : 0.4;
  }

  /** @override blazes (and anything fire-based) take real damage. */
  onEntityHit(target) {
    const dmg = target.type === 'blaze' ? this.blazeDamage : this.damage;
    if (dmg > 0) this.dealDamage(target, dmg);
    else {
      // A snowball with no bite still knocks you about.
      this.pushTarget(target, this.knockbackStrength);
    }
    this.onImpact(null, target);
    if (!this.removed) this.discard();
  }

  /** @override */
  onImpact(hit, target) {
    particles('snowball', this.x, this.y, this.z, { count: 8, spread: 0.25 });
    playAt(this.world, 'hit', this.x, this.y, this.z, 0.4, 1.6);
  }
}

/** Egg: harmless, and one in eight hatches a chick. */
export class EggEntity extends ThrownItem {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    this.type = 'egg';
    this.damageType = 'thrown';
    this.itemName = (opts && opts.item) || 'egg';
    this.renderItem = 'egg';
    this.damage = 0;
    this.knockbackStrength = 0.3;
  }

  /** @override */
  onImpact(hit, target) {
    particles('block', this.x, this.y, this.z, { count: 8, spread: 0.25, color: 0xf0e6d2 });
    playAt(this.world, 'chicken_egg', this.x, this.y, this.z, 0.5, 1.3);
    if (!this.rng.chance(1 / 8)) return;
    const many = this.rng.chance(1 / 32) ? 4 : 1;
    for (let i = 0; i < many; i++) {
      spawnMob(this.world, 'chicken', this.x, this.y, this.z, { baby: true });
    }
  }
}

/** Ender pearl: teleports the thrower and hurts them for the trouble. */
export class EnderPearlEntity extends ThrownItem {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    this.type = 'ender_pearl';
    this.itemName = (opts && opts.item) || 'ender_pearl';
    this.renderItem = 'ender_pearl';
    this.damage = 0;
    this.knockbackStrength = 0;
  }

  /** @override */
  afterMove(dt) {
    if ((this.age & 1) === 0) {
      particles('portal', this.x, this.y + 0.1, this.z, { count: 1, spread: 0.15, life: 0.5 });
    }
  }

  /** @override */
  onImpact(hit, target) {
    const o = this.owner;
    if (!o || o.removed || (o.dead && !isPlayerLike(o))) return;
    if (o.world && this.world && o.world !== this.world) return;

    const dest = this.safeLanding(hit);
    particles('portal', o.x, o.y + 1, o.z, { count: 16, spread: 0.6 });
    playAt(this.world, 'enderman_teleport', o.x, o.y, o.z, 1, 1);

    o.fallDistance = 0;
    if (typeof o.teleport === 'function') { try { o.teleport(dest.x, dest.y, dest.z); } catch { o.setPosition(dest.x, dest.y, dest.z); } }
    else o.setPosition(dest.x, dest.y, dest.z);
    o.vx = 0; o.vy = 0; o.vz = 0;

    particles('portal', dest.x, dest.y + 1, dest.z, { count: 16, spread: 0.6 });
    playAt(this.world, 'enderman_teleport', dest.x, dest.y, dest.z, 1, 1);

    if (isPlayerLike(o)) {
      try {
        damageEntity(o, 5, damageSource('fall', null, null, { fall: true, bypassCooldown: true }));
      } catch { /* optional */ }
      // 5% of the time the pearl brings something along.
      if (this.rng.chance(0.05)) spawnMob(this.world, 'endermite', dest.x, dest.y, dest.z, {});
    }
  }

  /** Finds a spot at the impact point where the thrower will not suffocate. */
  safeLanding(hit) {
    const w = this.world;
    let x = this.x, y = this.y, z = this.z;
    if (hit) {
      const dir = FACE_DIRS[hit.face] || FACE_DIRS[FACE_UP];
      x += dir[0] * 0.4; y += dir[1] * 0.4; z += dir[2] * 0.4;
      if (hit.face === FACE_UP) y = hit.y + 1.02;
    }
    if (!w) return { x, y, z };
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let dy = 0; dy <= 4; dy++) {
      const by = Math.floor(y) + dy;
      if (by < 0 || by + 1 >= WORLD_HEIGHT) continue;
      if (!w.isSolid(bx, by, bz) && !w.isSolid(bx, by + 1, bz)) {
        return { x: bx + 0.5, y: by, z: bz + 0.5 };
      }
    }
    return { x, y, z };
  }
}

/** Bottle o' Enchanting: shatters into experience. */
export class ExperienceBottleEntity extends ThrownItem {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    this.type = 'experience_bottle';
    this.itemName = (opts && opts.item) || 'experience_bottle';
    this.renderItem = 'experience_bottle';
    this.gravity = 0.07 * TICKS_PER_SECOND * TICKS_PER_SECOND;
    this.damage = 0;
    this.knockbackStrength = 0;
  }

  /** @override */
  onImpact(hit, target) {
    particles('enchant', this.x, this.y, this.z, { count: 12, spread: 0.4 });
    playAt(this.world, 'break', this.x, this.y, this.z, 0.7, 1.4);
    dropXP(this.world, this.x, this.y, this.z, 3 + this.rng.int(5) + this.rng.int(5));
  }
}

/** Splash and lingering potions. */
export class ThrownPotion extends ThrownItem {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.lingering = !!o.lingering;
    this.type = this.lingering ? 'lingering_potion' : 'splash_potion';
    this.damageType = 'magic';
    this.gravity = 0.05 * TICKS_PER_SECOND * TICKS_PER_SECOND;
    this.damage = 0;
    this.knockbackStrength = 0;
    this.potion = resolvePotion(o.potion, o.item);
    this.itemName = o.item || potionItemNameFor(this.potion, this.lingering);
    this.renderItem = this.itemName;
    this.payload = normalizeEffects(o.effects) ||
      effectsFromPotion(this.potion, this.lingering ? 'lingering_potion' : 'splash_potion');
    const tint = potionColorFor(this.itemName, this.potion);
    this.color = tint == null ? 0x385dc6 : tint;
    this.isWater = !this.payload || !this.payload.length;
  }

  /** @override */
  afterMove(dt) {
    if ((this.age & 1) === 0) {
      particles('magic', this.x, this.y + 0.1, this.z,
        { count: 1, color: this.color, spread: 0.08, life: 0.4 });
    }
  }

  /** @override */
  onImpact(hit, target) {
    const w = this.world;
    playAt(w, 'break', this.x, this.y, this.z, 0.9, 1 + this.rng.next() * 0.2);
    particles('splash', this.x, this.y, this.z, { count: 14, spread: 0.5, color: this.color });
    if (this.lingering) this.makeCloud();
    else this.splash(target);
    if (this.isWater) this.douseFires(hit);
  }

  /** Applies the potion to everything nearby, weakening with distance. */
  splash(directTarget) {
    const w = this.world;
    if (!w) return;
    _queryBox.set(this.x - 4, this.y - 2, this.z - 4, this.x + 4, this.y + 2, this.z + 4);
    let list;
    try {
      list = w.entitiesInAABB(_queryBox, (e) => e && !e.removed && !e.projectile &&
        e.type !== 'area_effect_cloud' && typeof e.health === 'number');
    } catch { list = []; }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e === this) continue;
      const d = Math.sqrt(this.distanceToSq(e.x, centreY(e), e.z));
      if (d > 4) continue;
      let scale = e === directTarget ? 1 : 1 - d / 4;
      if (scale <= 0) continue;
      this.affect(e, scale);
    }
  }

  /**
   * One entity's share of the splash. Water bottles sting anything that hates
   * water; healing potions still invert on the undead through effects.js.
   */
  affect(e, scale) {
    if (this.isWater) {
      if (e.fireTicks > 0) { e.fireTicks = 0; playAt(this.world, 'fizz', e.x, e.y, e.z, 0.5, 1.6); }
      const hurtsInWater = e.type === 'blaze' || e.type === 'enderman' ||
        e.type === 'endermite' || e.type === 'strider' || e.type === 'snow_golem';
      if (hurtsInWater) {
        try { damageEntity(e, 1, this.makeSource({ magic: true })); } catch { /* optional */ }
      }
      return;
    }
    const list = this.payload;
    for (let i = 0; i < list.length; i++) {
      const fx = list[i];
      const instant = fx.instant;
      const ticks = instant ? 1 : Math.max(1, Math.floor(fx.ticks * scale));
      if (!instant && ticks < 20) continue;
      try {
        if (instant) applyInstantScaled(e, fx.name, fx.level, scale);
        else addEffect(e, fx.name, ticks, fx.level | 0);
      } catch { /* optional */ }
    }
    // A weakened zombie villager is one golden apple from being cured again.
    if (e.type === 'zombie_villager' && this.hasEffectNamed('weakness')) {
      particles('angry', e.x, e.y + 2, e.z, { count: 3 });
    }
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.lingering = this.lingering;
    o.potion = this.potion;
    return o;
  }

  /** True when the potion carries the named effect. */
  hasEffectNamed(name) {
    const list = this.payload;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) if (list[i].name === name) return true;
    return false;
  }

  /** Lingering potions leave a shrinking cloud behind. */
  makeCloud() {
    const w = this.world;
    if (!w) return;
    const cloud = new AreaEffectCloud(w, this.x, this.y, this.z, {
      radius: 3,
      duration: 600,
      waitTime: 10,
      radiusOnUse: -0.5,
      durationOnUse: -20,
      radiusPerTick: -0.005,
      reapplicationDelay: 20,
      color: this.color,
      effects: this.payload,
      owner: this.owner,
      potion: this.potion,
    });
    w.addEntity(cloud);
  }

  /** A thrown water bottle puts out any fire it lands next to. */
  douseFires(hit) {
    const w = this.world;
    if (!w) return;
    const fire = blockByName('fire');
    const soulFire = blockByName('soul_fire');
    const cx = Math.floor(this.x), cy = Math.floor(this.y), cz = Math.floor(this.z);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const id = w.getBlock(cx + dx, cy + dy, cz + dz);
          if (!id) continue;
          if ((fire && id === fire.id) || (soulFire && id === soulFire.id)) {
            w.setBlock(cx + dx, cy + dy, cz + dz, 0, 0, 3);
            playAt(w, 'fizz', cx + dx, cy + dy, cz + dz, 0.5, 1.4);
          }
        }
      }
    }
  }
}

// ===========================================================================
// Hurting projectiles (fireballs and skulls)
// ===========================================================================

/** Self-propelled, gravity-free projectiles that leave a smoke trail. */
export class HurtingProjectile extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    this.type = 'fireball';
    this.damageType = 'fireball';
    this.width = 0.5; this.height = 0.5; this.eyeHeight = 0.25;
    this.noGravity = true;
    this.gravity = 0;
    this.dragPerTick = 0.95;
    this.waterDragPerTick = 0.8;
    // Vanilla's 0.1 blocks/tick^2 acceleration along the flight direction.
    this.accel = 0.1 * TICKS_PER_SECOND * TICKS_PER_SECOND;
    this.deflectable = true;
    this.maxLife = 600;
    this.trail = 'smoke';
    // combat.damageEntity never calls hurt(); it consults `def.onHurt` instead,
    // so this is how a punch or an arrow turns a fireball around.
    this.def = deflectDef('fireball');
  }

  /** @override */
  afterMove(dt) {
    if ((this.age & 1) === 0) {
      particles(this.trail, this.x, this.y + 0.1, this.z, { count: 1, spread: 0.1, life: 0.5 });
    }
  }

  /** @override a punch (or an arrow) sends it back the way it came. */
  hurt(amount, source = null) {
    if (this.removed) return false;
    const by = source && (source.entity || source.direct);
    if (this.deflectable && by && by !== this) {
      deflect(this, by);
      return true;
    }
    return false;
  }

  /** @override */
  onBlockHit(hit) { this.onImpact(hit, null); if (!this.removed) this.discard(); }

  /** @override */
  onEntityHit(target) { this.onImpact(null, target); if (!this.removed) this.discard(); }
}

/** A ghast's fireball: an explosion you can bat back. */
export class LargeFireball extends HurtingProjectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'fireball';
    this.itemName = 'fire_charge';
    this.renderItem = 'fire_charge';
    this.explosionPower = o.explosionPower !== undefined ? o.explosionPower : 1;
    this.damage = o.damage !== undefined ? o.damage : 6;
    this.renderScale = 0.9;
    this.trail = 'smoke';
  }

  /** @override */
  onImpact(hit, target) {
    const w = this.world;
    if (target) {
      try { damageEntity(target, this.damage, this.makeSource({ fire: true })); } catch { /* optional */ }
      try { setOnFire(target, 5); } catch { /* optional */ }
    }
    const grief = griefingAllowed(w);
    try {
      explode(w, this.x, this.y, this.z, this.explosionPower, {
        fire: grief, breakBlocks: grief, source: this.owner || this, entity: this.owner || this,
      });
    } catch {
      particles('explosion', this.x, this.y, this.z, { count: 1, size: this.explosionPower });
      playAt(w, 'explode', this.x, this.y, this.z, 4, 1);
    }
  }
}

/** A blaze's little fireball: no crater, just a burn. */
export class SmallFireball extends HurtingProjectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'small_fireball';
    this.def = deflectDef(this.type);
    this.damageType = 'small_fireball';
    this.width = 0.3125; this.height = 0.3125;
    this.itemName = 'fire_charge';
    this.renderItem = 'fire_charge';
    this.renderScale = 0.4;
    this.damage = o.damage !== undefined ? o.damage : 5;
    this.fireSeconds = o.fireSeconds !== undefined ? o.fireSeconds : 5;
    this.trail = 'flame';
  }

  /** @override */
  onImpact(hit, target) {
    if (target) {
      let ok = false;
      try { ok = damageEntity(target, this.damage, this.makeSource({ fire: true })); } catch { ok = false; }
      if (ok || target.invulnerable) { try { setOnFire(target, this.fireSeconds); } catch { /* optional */ } }
      return;
    }
    if (!hit || !griefingAllowed(this.world)) return;
    const fire = blockByName('fire');
    if (!fire || !this.world) return;
    const dir = FACE_DIRS[hit.face] || FACE_DIRS[FACE_UP];
    const fx = hit.x + dir[0], fy = hit.y + dir[1], fz = hit.z + dir[2];
    if (fy < 0 || fy >= WORLD_HEIGHT) return;
    try { if (this.world.isAir(fx, fy, fz)) this.world.setBlock(fx, fy, fz, fire.id, 0, 3); }
    catch { /* optional */ }
  }
}

/** The ender dragon's breath attack: a lingering pool of acid. */
export class DragonFireball extends HurtingProjectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'dragon_fireball';
    this.def = deflectDef(this.type);
    this.damageType = 'dragon_breath';
    this.width = 1; this.height = 1; this.eyeHeight = 0.5;
    this.itemName = 'dragon_breath';
    this.renderItem = 'dragon_breath';
    this.renderScale = 1;
    this.damage = o.damage !== undefined ? o.damage : 6;
    this.cloudRadius = o.breath ? 4 : 3;
    this.deflectable = false;
    this.trail = 'dragon_breath';
    this.accel = 0.05 * TICKS_PER_SECOND * TICKS_PER_SECOND;
  }

  /** @override */
  afterMove(dt) {
    if ((this.age & 1) === 0) {
      particles('magic', this.x, this.y + 0.2, this.z,
        { count: 2, color: 0xb060d0, spread: 0.2, life: 0.6 });
    }
  }

  /** @override */
  onImpact(hit, target) {
    const w = this.world;
    if (!w) return;
    const cloud = new AreaEffectCloud(w, this.x, this.y, this.z, {
      radius: this.cloudRadius,
      duration: 600,
      waitTime: 10,
      radiusOnUse: -0.5,
      durationOnUse: -20,
      radiusPerTick: -0.005,
      reapplicationDelay: 20,
      color: 0xb060d0,
      particle: 'magic',
      owner: this.owner,
      effects: [{ name: 'instant_damage', ticks: 1, level: 0, instant: true }],
    });
    w.addEntity(cloud);
    playAt(w, 'dragon_growl', this.x, this.y, this.z, 1, 1.4);
  }
}

/** A wither skull: withers what it hits, and the blue one digs. */
export class WitherSkull extends HurtingProjectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'wither_skull';
    this.def = deflectDef(this.type);
    this.damageType = 'wither_skull';
    this.width = 0.3125; this.height = 0.3125;
    this.itemName = 'wither_skeleton_skull';
    this.renderItem = 'wither_skeleton_skull';
    this.renderScale = 0.5;
    this.blue = !!o.blue;
    this.damage = o.damage !== undefined ? o.damage : 8;
    this.payload = normalizeEffects(o.effects) || [{ name: 'wither', ticks: 200, level: 1, instant: false }];
    this.deflectable = false;
    this.trail = 'smoke';
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.blue = this.blue;
    return o;
  }

  /** @override */
  afterMove(dt) {
    particles(this.blue ? 'soul' : 'smoke', this.x, this.y + 0.1, this.z,
      { count: 1, spread: 0.1, life: 0.5, color: this.blue ? 0x55ddff : 0x2a2a2a });
  }

  /** @override */
  onImpact(hit, target) {
    const w = this.world;
    if (target) {
      let ok = false;
      try { ok = damageEntity(target, this.damage, this.makeSource({ magic: true })); } catch { ok = false; }
      if (ok && !isUndead(target)) {
        const ticks = difficultyId(w) >= DIFFICULTY.HARD ? 800 : 200;
        for (const fx of this.payload) {
          try { addEffect(target, fx.name, ticks, fx.level | 0); } catch { /* optional */ }
        }
      }
    }
    const grief = griefingAllowed(w);
    try {
      explode(w, this.x, this.y, this.z, 1, {
        fire: false,
        breakBlocks: this.blue && grief,
        source: this.owner || this, entity: this.owner || this,
      });
    } catch {
      particles('explosion', this.x, this.y, this.z, { count: 1, size: 1 });
      playAt(w, 'explode', this.x, this.y, this.z, 2, 1.2);
    }
  }
}

/** Breeze wind charge: no wound to speak of, but a colossal shove. */
export class WindCharge extends HurtingProjectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'wind_charge';
    this.def = deflectDef(this.type);
    this.damageType = 'wind_charge';
    this.width = 0.3125; this.height = 0.3125;
    this.itemName = 'wind_charge';
    this.renderItem = 'wind_charge';
    this.renderScale = 0.5;
    this.damage = o.damage !== undefined ? o.damage : 1;
    this.burstKnockback = o.knockback !== undefined ? o.knockback : 1.8;
    this.accel = 0;
    this.dragPerTick = 1;
    this.deflectable = false;
    this.maxLife = 200;
    this.trail = 'cloud';
  }

  /** @override */
  onImpact(hit, target) {
    const w = this.world;
    particles('cloud', this.x, this.y, this.z, { count: 16, spread: 1.2, life: 0.6 });
    playAt(w, 'breeze_wind_burst', this.x, this.y, this.z, 1, 1);
    if (!w) return;
    let list;
    try { list = w.entitiesNear(this.x, this.y, this.z, 3, (e) => e && !e.removed && e !== this); }
    catch { list = []; }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const d = Math.sqrt(this.distanceToSq(e.x, centreY(e), e.z));
      const f = clamp(1 - d / 3, 0, 1);
      if (f <= 0) continue;
      if (e === target && this.damage > 0) {
        try { damageEntity(e, this.damage, this.makeSource()); } catch { /* optional */ }
      }
      try {
        applyKnockback(e, this.x, this.y, this.z, this.burstKnockback * f, true);
      } catch { /* optional */ }
    }
  }
}

// ===========================================================================
// Odd one-offs
// ===========================================================================

/** Llama spit: one point of damage and a lot of indignation. */
export class LlamaSpit extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'llama_spit';
    this.damageType = 'llama_spit';
    this.width = 0.25; this.height = 0.25;
    this.gravity = SPIT_GRAVITY;
    this.dragPerTick = 0.99;
    this.damage = o.damage !== undefined ? o.damage : 1;
    this.knockbackStrength = 0.2;
    this.itemName = 'string';
    this.renderItem = 'string';
    this.renderScale = 0.35;
    this.maxLife = 200;
  }

  /** @override */
  onBlockHit(hit) {
    particles('splash', this.x, this.y, this.z, { count: 6, spread: 0.2, color: 0xd8d8d8 });
    this.discard();
  }

  /** @override */
  onEntityHit(target) {
    this.dealDamage(target, this.damage);
    particles('splash', this.x, this.y, this.z, { count: 6, spread: 0.2, color: 0xd8d8d8 });
    playAt(this.world, 'llama_spit', this.x, this.y, this.z, 0.8, 1);
    this.discard();
  }
}

/** Shulker bullet: slow, relentless, and it leaves you floating. */
export class ShulkerBullet extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'shulker_bullet';
    this.damageType = 'shulker_bullet';
    this.width = 0.3125; this.height = 0.3125;
    this.noGravity = true;
    this.gravity = 0;
    this.dragPerTick = 1;
    this.damage = o.damage !== undefined ? o.damage : 4;
    this.target = o.target || null;
    this.homing = o.homing !== false;
    this.cruiseSpeed = 8;
    this.payload = normalizeEffects(o.effects) || [{ name: 'levitation', ticks: 200, level: 0, instant: false }];
    this.itemName = 'shulker_shell';
    this.renderItem = 'shulker_shell';
    this.renderScale = 0.4;
    this.maxLife = 600;
    this.deflectable = true;
    this.def = deflectDef('shulker_bullet');
  }

  /** @override steers toward the target, vanilla's lazy homing. */
  afterMove(dt) {
    particles('end_rod', this.x, this.y, this.z, { count: 1, spread: 0.08, life: 0.5 });
    const t = this.target;
    if (!this.homing || !t || t.removed || t.dead) return;
    const dx = t.x - this.x;
    const dy = centreY(t) - (this.y + this.height * 0.5);
    const dz = t.z - this.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-3) return;
    const wantX = (dx / d) * this.cruiseSpeed;
    const wantY = (dy / d) * this.cruiseSpeed;
    const wantZ = (dz / d) * this.cruiseSpeed;
    const f = 1 - Math.pow(0.88, dt * TICKS_PER_SECOND);
    this.vx += (wantX - this.vx) * f;
    this.vy += (wantY - this.vy) * f;
    this.vz += (wantZ - this.vz) * f;
  }

  /** @override */
  hurt(amount, source = null) {
    // Shulker bullets can be shot down or punched away.
    const by = source && (source.entity || source.direct);
    if (by) { deflect(this, by); return true; }
    particles('crit', this.x, this.y, this.z, { count: 6, spread: 0.3 });
    this.discard();
    return true;
  }

  /** @override */
  onBlockHit(hit) {
    particles('crit', this.x, this.y, this.z, { count: 8, spread: 0.25 });
    playAt(this.world, 'shulker_bullet_hit', this.x, this.y, this.z, 0.8, 1);
    this.discard();
  }

  /** @override */
  onEntityHit(target) {
    let ok = false;
    try { ok = damageEntity(target, this.damage, this.makeSource()); } catch { ok = false; }
    if (ok) {
      for (const fx of this.payload) {
        try { addEffect(target, fx.name, Math.max(1, fx.ticks | 0), fx.level | 0); } catch { /* optional */ }
      }
    }
    particles('crit', this.x, this.y, this.z, { count: 8, spread: 0.25 });
    playAt(this.world, 'shulker_bullet_hit', this.x, this.y, this.z, 0.9, 1);
    this.discard();
  }
}

/** Eye of Ender: drifts toward the nearest stronghold and usually survives. */
export class EnderEye extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    this.type = 'eye_of_ender';
    this.width = 0.25; this.height = 0.25;
    this.noGravity = true;
    this.gravity = 0;
    this.dragPerTick = 1;
    this.hitsBlocks = false;
    this.hitsEntities = false;
    this.itemName = 'ender_eye';
    this.renderItem = 'ender_eye';
    this.renderScale = 0.4;
    this.maxLife = 80;
    this.survives = rngOf(this.owner || world).chance(0.8);
    this.targetX = (opts && opts.targetX);
    this.targetZ = (opts && opts.targetZ);
    if (this.targetX === undefined || this.targetZ === undefined) {
      const sp = (world && world.spawnPoint) || { x: 0, z: 0 };
      this.targetX = sp.x; this.targetZ = sp.z;
    }
  }

  /** @override climbs, then glides toward the target column. */
  afterMove(dt) {
    particles('portal', this.x, this.y, this.z, { count: 2, spread: 0.2, life: 0.6 });
    const dx = this.targetX - this.x, dz = this.targetZ - this.z;
    const flat = Math.hypot(dx, dz) || 1;
    const climb = this.life < 20 ? 6 : 1.5;
    this.vx = (dx / flat) * 16;
    this.vz = (dz / flat) * 16;
    this.vy = climb;
    this.faceVelocity();
  }

  /** @override drops itself back four times out of five. */
  expire() {
    if (this.survives) dropStack(this.world, this.x, this.y, this.z, itemStack('ender_eye', 1), 0, 0.5, 0);
    else particles('portal', this.x, this.y, this.z, { count: 12, spread: 0.5 });
    this.discard();
  }
}

/** A firework rocket: flies, then bangs (and hurts, if it carries stars). */
export class FireworkRocket extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'firework_rocket';
    this.damageType = 'firework';
    this.width = 0.25; this.height = 0.25;
    this.noGravity = true;
    this.gravity = 0;
    this.dragPerTick = 1;
    this.accel = 22;
    // A decorative rocket flies straight through the world; only one that
    // carries stars (or came out of a crossbow) explodes on contact.
    this.hitsEntities = !!o.explodeOnImpact || !!o.crossbow || !!(o.colors && o.colors.length);
    this.hitsBlocks = this.hitsEntities;
    this.itemName = o.item || 'firework_rocket';
    this.renderItem = 'firework_rocket';
    this.renderScale = 0.5;
    this.flight = clamp((o.flight !== undefined ? o.flight : 1) | 0, 1, 3);
    this.colors = Array.isArray(o.colors) ? o.colors.slice() : null;
    this.stars = o.stars !== undefined ? (o.stars | 0) : (this.colors ? this.colors.length : 0);
    this.attached = o.attached || null;
    const r = rngOf(this.owner || world);
    this.maxLife = 10 * this.flight + r.int(6) + r.int(7);
  }

  /** @override */
  afterMove(dt) {
    particles('firework', this.x, this.y, this.z, { count: 1, spread: 0.05, life: 0.4 });
    if ((this.age % 4) === 0) playAt(this.world, 'firework_launch', this.x, this.y, this.z, 0.15, 1.6);
  }

  /** @override rockets glued to a flying player follow them. */
  tickLogic() {
    const a = this.attached;
    if (a && !a.removed) {
      this.setPosition(a.x, a.y + a.height * 0.5, a.z);
      this.vx = a.vx; this.vy = a.vy; this.vz = a.vz;
    }
  }

  /** @override */
  onBlockHit(hit) { this.detonate(null); }
  /** @override */
  onEntityHit(target) { this.detonate(target); }
  /** @override */
  expire() { this.detonate(null); }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.flight = this.flight;
    o.colors = this.colors ? this.colors.slice() : null;
    o.stars = this.stars;
    o.explodeOnImpact = this.hitsEntities;
    return o;
  }

  /** The bang: particles, a boom, and shrapnel damage if it has stars. */
  detonate(direct) {
    const w = this.world;
    const color = this.colors && this.colors.length
      ? this.colors[this.rng.int(this.colors.length)] : 0xffffff;
    particles('firework', this.x, this.y, this.z,
      { count: 60, spread: 2.2, color, life: 1.2, gravity: 0.2 });
    particles('explosion', this.x, this.y, this.z, { count: 1, size: 1 });
    playAt(w, 'firework_blast', this.x, this.y, this.z, 3, 1);
    playAt(w, 'firework_twinkle', this.x, this.y, this.z, 2, 1.2);

    if (this.stars > 0 && w) {
      const dmg = 5 + this.stars * 2;
      let list;
      try { list = w.entitiesNear(this.x, this.y, this.z, 5, (e) => e && !e.removed && typeof e.health === 'number'); }
      catch { list = []; }
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e === this.attached) continue;
        const d = Math.sqrt(this.distanceToSq(e.x, centreY(e), e.z));
        const f = e === direct ? 1 : clamp(1 - d / 5, 0, 1);
        if (f <= 0) continue;
        try {
          damageEntity(e, Math.max(1, Math.round(dmg * f)),
            damageSource('firework', this.owner || null, this, { explosion: true, projectile: true }));
        } catch { /* optional */ }
      }
    }
    this.discard();
  }
}

/** The fishing bobber: bobs, waits, and hauls things in. */
export class FishingBobber extends Projectile {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z, opts);
    const o = opts || {};
    this.type = 'fishing_bobber';
    this.width = 0.25; this.height = 0.25;
    this.gravity = THROWN_GRAVITY;
    this.dragPerTick = 0.92;
    this.waterDragPerTick = 0.6;
    this.maxLife = 24000;
    this.itemName = 'fishing_rod';
    this.renderItem = 'fishing_bobber';
    this.renderScale = 0.35;
    this.hitsEntities = true;

    /** 'flying' | 'hooked' | 'bobbing' */
    this.state = 'flying';
    this.hooked = null;
    this.floatY = 0;
    this.bobPhase = this.rng.next() * Math.PI * 2;
    this.lure = o.lure !== undefined ? o.lure : ench(heldOf(this.owner), 'lure');
    this.luck = o.luck !== undefined ? o.luck : ench(heldOf(this.owner), 'luck_of_the_sea');
    this.timeUntilLured = 0;
    this.nibbleTicks = 0;
    this.openWater = true;
    this.rodStack = o.stack || null;
  }

  /** @override the bobber only ever snags one thing. */
  canHitEntity(e) {
    if (!super.canHitEntity(e)) return false;
    if (e === this.owner) return false;
    return this.state === 'flying';
  }

  /** @override */
  onEntityHit(target) {
    this.hooked = target;
    this.state = 'hooked';
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.noGravity = true;
    this.gravity = 0;
    this.hitsBlocks = false;
    this.hitsEntities = false;
    playAt(this.world, 'bubble', this.x, this.y, this.z, 0.4, 1.5);
  }

  /** @override the bobber does not stick in stone, it just stops. */
  onBlockHit(hit) {
    const dir = FACE_DIRS[hit.face] || FACE_DIRS[FACE_UP];
    this.x += dir[0] * 0.02; this.y += dir[1] * 0.02; this.z += dir[2] * 0.02;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.inGround = true;
    this.stuckIn.x = hit.x; this.stuckIn.y = hit.y; this.stuckIn.z = hit.z; this.stuckIn.id = hit.id;
  }

  /** @override */
  groundUpdate(dt) {
    const w = this.world;
    if (!w) return;
    // A fast cast can reach the lake bed in one pass without ever running
    // afterMove, so the float check has to live here as well.
    if (this.state === 'flying' && this.inWater) {
      this.inGround = false;
      this.enterWater();
      return;
    }
    const s = this.stuckIn;
    if (w.getBlock(s.x, s.y, s.z) !== s.id) { this.inGround = false; this.vy = -1; }
  }

  /** @override buoyancy once it lands in water. */
  afterMove(dt) {
    if (this.state === 'flying' && this.inWater) this.enterWater();
    if (this.state !== 'bobbing') return;
    // Sit on the surface with a gentle sinusoidal bob.
    this.bobPhase += dt * 3;
    const target = this.floatY + Math.sin(this.bobPhase) * 0.045;
    this.vy += (target - this.y) * 24 * dt;
    this.vy *= Math.pow(0.6, dt * TICKS_PER_SECOND);
    this.vx *= Math.pow(0.85, dt * TICKS_PER_SECOND);
    this.vz *= Math.pow(0.85, dt * TICKS_PER_SECOND);
  }

  /** Switches to float mode and starts the catch timer. */
  enterWater() {
    this.state = 'bobbing';
    this.noGravity = true;
    this.gravity = 0;
    this.floatY = this.waterSurfaceY();
    this.vx *= 0.1; this.vz *= 0.1; this.vy = 0;
    this.openWater = this.checkOpenWater();
    this.resetLureTimer();
    this.y = this.floatY;
    playAt(this.world, 'splash', this.x, this.y, this.z, 0.4, 1.2);
    particles('splash', this.x, this.y, this.z, { count: 8, spread: 0.3 });
  }

  /** Y of the top of the water column the bobber landed in. */
  waterSurfaceY() {
    const w = this.world;
    let y = Math.floor(this.y);
    if (!w) return y + 0.9;
    // Walk up while we are still in water, so a deep splash still floats.
    let guard = 0;
    while (y + 1 < WORLD_HEIGHT && w.isLiquid(Math.floor(this.x), y + 1, Math.floor(this.z)) && guard++ < 24) y++;
    return y + 0.9;
  }

  /** Vanilla's 100..600 tick wait, shortened by Lure and lengthened by rain. */
  resetLureTimer() {
    let t = 100 + this.rng.int(500) - this.lure * 100;
    const w = this.world;
    if (w && w.isRainingAt && w.isRainingAt(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))) {
      t = Math.floor(t * 0.75);
    }
    this.timeUntilLured = Math.max(20, t);
    this.nibbleTicks = 0;
  }

  /** Vanilla's open-water rule: the 5x5 around the float must be clear water. */
  checkOpenWater() {
    const w = this.world;
    if (!w) return true;
    const bx = Math.floor(this.x), by = Math.floor(this.y), bz = Math.floor(this.z);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!w.isLiquid(bx + dx, by, bz + dz)) return false;
        if (w.isSolid(bx + dx, by + 1, bz + dz)) return false;
      }
    }
    return true;
  }

  /** @override the catch timer and the bite animation. */
  tickLogic() {
    const o = this.owner;
    if (!o || o.removed || o.dead || this.distanceToSq(o.x, o.y, o.z) > 1024) {
      this.abandon();
      return;
    }
    // The rod must still be in hand.
    if (isPlayerLike(o)) {
      const held = heldOf(o);
      const off = typeof o.getOffhandItem === 'function' ? o.getOffhandItem() : null;
      const holdingRod = (held && held.item === 'fishing_rod') || (off && off.item === 'fishing_rod');
      if (!holdingRod) { this.abandon(); return; }
    }

    if (this.state === 'hooked') {
      const h = this.hooked;
      if (!h || h.removed) { this.hooked = null; this.state = 'flying'; return; }
      this.setPosition(h.x, centreY(h), h.z);
      return;
    }
    if (this.state !== 'bobbing') return;

    if (this.nibbleTicks > 0) {
      this.nibbleTicks--;
      this.vy -= 2;
      if (this.nibbleTicks === 0) this.resetLureTimer();
      return;
    }
    if (--this.timeUntilLured > 0) {
      // The tell-tale approach trail a few seconds before the bite.
      if (this.timeUntilLured < 40 && (this.age & 3) === 0) {
        const a = this.rng.next() * Math.PI * 2;
        const r = 0.5 + this.timeUntilLured * 0.03;
        particles('bubble', this.x + Math.cos(a) * r, this.y, this.z + Math.sin(a) * r,
          { count: 1, spread: 0.05 });
      }
      return;
    }
    this.nibbleTicks = 20 + this.rng.int(20);
    playAt(this.world, 'splash', this.x, this.y, this.z, 0.25, 1.6);
    particles('splash', this.x, this.y, this.z, { count: 10, spread: 0.2 });
  }

  /** Clears the owner's back-reference so items.js can cast again. */
  detach() {
    const o = this.owner;
    if (o && o.bobber === this) o.bobber = null;
  }

  /** Snapped line: no catch, no reel-in, just gone. */
  abandon() {
    this.nibbleTicks = 0;
    this.hooked = null;
    this.detach();
    this.discard();
  }

  /**
   * @override reeling in is what `remove()` means for a bobber, so items.js
   * only has to call `bobber.remove()`.
   */
  remove() {
    if (this.removed) return;
    try { this.retrieve(); } catch (e) { console.error('[bobber] retrieve failed', e); }
    this.detach();
    super.remove();
  }

  /** Hands over the catch, or drags whatever is hooked toward the angler. */
  retrieve() {
    const o = this.owner;
    if (!o || o.removed) return;
    if (this.hooked && !this.hooked.removed) {
      // Reel the victim in: a shove straight at the angler.
      const dx = o.x - this.hooked.x, dy = o.y - this.hooked.y, dz = o.z - this.hooked.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      this.hooked.vx += (dx / d) * 8;
      this.hooked.vy += (dy / d) * 6 + 2;
      this.hooked.vz += (dz / d) * 8;
      this.hooked.onGround = false;
      playAt(this.world, 'whoosh', o.x, o.y, o.z, 0.6, 1.2);
      return;
    }
    if (this.nibbleTicks <= 0) return;

    // A real catch: fly the loot at the angler and hand out a little XP.
    let loot = [];
    let luck = this.luck;
    try { luck += (typeof o.getEffectLevel === 'function' ? o.getEffectLevel('luck') : 0); } catch { /* optional */ }
    try { loot = fishingLoot(this.rng, luck, this.openWater) || []; } catch { loot = []; }
    if (!loot.length) loot = [itemStack('cod', 1)];
    for (let i = 0; i < loot.length; i++) {
      const s = loot[i];
      if (isEmpty(s)) continue;
      const dx = o.x - this.x, dy = o.y + 0.5 - this.y, dz = o.z - this.z;
      const item = dropStack(this.world, this.x, this.y, this.z, s, dx * 0.9, dy * 0.9 + Math.sqrt(dx * dx + dz * dz) * 0.5, dz * 0.9);
      if (!item) giveTo(o, s);
    }
    dropXP(this.world, o.x, o.y + 0.5, o.z, 1 + this.rng.int(6));
    playAt(this.world, 'splash', this.x, this.y, this.z, 0.6, 1.1);
    particles('splash', this.x, this.y, this.z, { count: 12, spread: 0.3 });
    this.nibbleTicks = 0;
  }
}

/** An end crystal: decorative until something hits it, then a 6-power blast. */
export class EndCrystal extends Entity {
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'end_crystal';
    this.width = 2; this.height = 2; this.eyeHeight = 1;
    this.noGravity = true;
    this.gravity = 0;
    this.noClip = true;
    this.pushable = false;
    this.showBase = (opts && opts.showBase) !== false;
    this.beamTarget = null;
    this.health = 1; this.maxHealth = 1;
    // combat.damageEntity routes through def.onHurt, so this is how a hit
    // detonates the crystal rather than merely killing the entity.
    this.def = {
      name: 'end_crystal', display: 'End Crystal', category: 'projectile',
      model: 'item', skin: 'item',
      onHurt: (self, amount, src) => { self.detonate(src); return false; },
    };
    this.model = 'item';
    this.skin = 'item';
    this.billboard = true;
    this.renderItem = 'end_crystal';
    this.renderScale = 1.2;
  }

  /** @override crystals do not fall; they hover and spin in place. */
  update(dt) {
    if (this.removed) return;
    this.px = this.x; this.py = this.y; this.pz = this.z;
  }

  /** @override */
  tick() {
    if (this.removed) return;
    this.age++;
    if ((this.age & 7) === 0) {
      particles('end_rod', this.x, this.y + 1.4, this.z, { count: 1, spread: 0.3, life: 0.8 });
    }
  }

  /** @override any hit at all detonates it. */
  hurt(amount, source = null) {
    this.detonate(source);
    return true;
  }

  /** Removes the crystal and drops a power-6 blast where it stood. */
  detonate(source) {
    if (this.removed) return;
    const w = this.world;
    this.remove();
    try {
      explode(w, this.x, this.y + 1, this.z, 6, {
        fire: false, breakBlocks: griefingAllowed(w),
        source: (source && source.entity) || null,
      });
    } catch {
      particles('explosion', this.x, this.y + 1, this.z, { count: 1, size: 6 });
      playAt(w, 'explode', this.x, this.y, this.z, 4, 0.9);
    }
  }
}

// ===========================================================================
// AreaEffectCloud
// ===========================================================================

/**
 * The shrinking puddle a lingering potion (or a dragon's breath) leaves
 * behind. It applies its payload on a cooldown per victim and gets smaller
 * every time it does.
 */
export class AreaEffectCloud extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {object} [opts] { radius, duration, waitTime, radiusOnUse,
   *   durationOnUse, radiusPerTick, reapplicationDelay, color, particle,
   *   effects, owner, potion }
   */
  constructor(world, x = 0, y = 0, z = 0, opts = {}) {
    super(world, x, y, z);
    const o = opts || {};
    this.type = 'area_effect_cloud';

    this.radius = o.radius !== undefined ? o.radius : 3;
    this.startRadius = this.radius;
    this.duration = o.duration !== undefined ? o.duration : 600;
    this.waitTime = o.waitTime !== undefined ? o.waitTime : 10;
    this.radiusOnUse = o.radiusOnUse !== undefined ? o.radiusOnUse : -0.5;
    this.durationOnUse = o.durationOnUse !== undefined ? o.durationOnUse : -20;
    this.radiusPerTick = o.radiusPerTick !== undefined ? o.radiusPerTick : -0.005;
    this.reapplicationDelay = o.reapplicationDelay !== undefined ? o.reapplicationDelay : 20;
    this.color = o.color !== undefined ? o.color : 0x385dc6;
    this.particle = o.particle || 'magic';
    this.potion = o.potion || null;
    this.payload = normalizeEffects(o.effects) || [];
    this.owner = o.owner || null;
    this.ownerId = this.owner ? this.owner.id : null;

    /** entityId -> the tick at which that entity may be dosed again. */
    this.victims = new Map();

    this.height = 0.5;
    this.width = this.radius * 2;
    this.eyeHeight = 0.25;
    this.noGravity = true;
    this.gravity = 0;
    this.noClip = true;
    this.pushable = false;
    this.invulnerable = true;
    this.health = 1; this.maxHealth = 1;
    this.rng = rngOf(this.owner || world);

    this.model = 'item';
    this.skin = 'item';
    this.billboard = true;
    this.renderItem = 'lingering_potion';
    this.renderScale = 1;
  }

  /** @override clouds never move, so the per-frame step is a no-op. */
  update(dt) {
    if (this.removed) return;
    this.px = this.x; this.py = this.y; this.pz = this.z;
    this._updatedSinceTick = true;
  }

  /** @override shrink, puff, and dose whoever is standing in it. */
  tick() {
    if (this.removed) return;
    this.age++;
    this._updatedSinceTick = false;

    if (this.age >= this.duration) { this.discard(); return; }

    if (this.radiusPerTick !== 0) {
      this.radius += this.radiusPerTick;
      if (this.radius < 0.05) { this.discard(); return; }
      this.width = this.radius * 2;
    }

    this.puff();

    const waiting = this.age < this.waitTime;
    if (waiting || !this.payload.length) return;
    if ((this.age & 1) !== 0) return;         // vanilla doses every other tick

    const w = this.world;
    if (!w) return;
    _queryBox.set(
      this.x - this.radius, this.y - 0.5, this.z - this.radius,
      this.x + this.radius, this.y + this.height + 0.5, this.z + this.radius,
    );
    let list;
    try { list = w.entitiesInAABB(_queryBox, (e) => e && !e.removed && typeof e.health === 'number' && e !== this); }
    catch { list = []; }

    let used = false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const dx = e.x - this.x, dz = e.z - this.z;
      if (dx * dx + dz * dz > this.radius * this.radius) continue;
      const ready = this.victims.get(e.id);
      if (ready !== undefined && this.age < ready) continue;
      this.victims.set(e.id, this.age + this.reapplicationDelay);
      this.dose(e);
      used = true;
    }
    // Entities that walked off long ago must not pile up in the map.
    if (this.victims.size > 32) {
      for (const [id, ready] of this.victims) if (ready < this.age) this.victims.delete(id);
    }
    if (!used) return;

    if (this.radiusOnUse !== 0) {
      this.radius += this.radiusOnUse;
      this.width = this.radius * 2;
      if (this.radius <= 0.05) { this.discard(); return; }
    }
    if (this.durationOnUse !== 0) {
      this.duration += this.durationOnUse;
      if (this.duration <= this.age) this.discard();
    }
  }

  /** Applies the payload to one entity. */
  dose(e) {
    for (let i = 0; i < this.payload.length; i++) {
      const fx = this.payload[i];
      try {
        if (fx.instant) addEffect(e, fx.name, 1, fx.level | 0);
        else addEffect(e, fx.name, Math.max(1, fx.ticks | 0), fx.level | 0);
      } catch { /* optional */ }
    }
  }

  /** The swirl of colour that makes the cloud visible. */
  puff() {
    if ((this.age & 1) !== 0) return;
    const n = Math.max(1, Math.min(6, Math.round(this.radius * 2)));
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = Math.sqrt(this.rng.next()) * this.radius;
      particles(this.particle, this.x + Math.cos(a) * r, this.y + 0.1, this.z + Math.sin(a) * r,
        { count: 1, color: this.color, size: 1.2, life: 0.8, gravity: 0 });
    }
  }

  /** Removes the cloud. */
  discard() { if (!this.removed) this.remove(); }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.radius = this.radius;
    o.duration = this.duration;
    o.waitTime = this.waitTime;
    o.color = this.color;
    o.potion = this.potion;
    o.payload = this.payload.map((e) => ({ name: e.name, ticks: e.ticks, level: e.level, instant: e.instant }));
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.radius !== undefined) { this.radius = obj.radius; this.width = this.radius * 2; }
    if (obj.duration !== undefined) this.duration = obj.duration;
    if (obj.waitTime !== undefined) this.waitTime = obj.waitTime;
    if (obj.color !== undefined) this.color = obj.color;
    if (obj.potion !== undefined) this.potion = obj.potion;
    if (obj.payload) this.payload = normalizeEffects(obj.payload) || [];
    return this;
  }
}

// ===========================================================================
// Potion / effect plumbing
// ===========================================================================

/**
 * Normalizes the several effect shapes callers use ({name|effect, ticks,
 * level}) into one, or returns null when there is nothing to normalize.
 */
function normalizeEffects(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e) continue;
    const name = e.name || e.effect || e.id;
    if (typeof name !== 'string') continue;
    out.push({
      name,
      ticks: e.ticks !== undefined ? e.ticks | 0 : (e.duration | 0) || 600,
      level: (e.level !== undefined ? e.level : e.amplifier) | 0,
      instant: e.instant !== undefined ? !!e.instant : INSTANT_EFFECTS.has(name),
    });
  }
  return out.length ? out : null;
}

/** Effects that fire once rather than ticking down. */
const INSTANT_EFFECTS = new Set(['instant_health', 'instant_damage', 'saturation']);

/** Resolves a potion id from an explicit option or from the item name. */
function resolvePotion(potionOpt, itemName) {
  if (typeof potionOpt === 'string') {
    try { const id = resolvePotionId(potionOpt); if (id) return id; } catch { /* optional */ }
    return potionOpt;
  }
  if (typeof itemName === 'string') {
    try { const id = resolvePotionId(itemName); if (id) return id; } catch { /* optional */ }
  }
  return 'water';
}

/** The registered item name for a potion in splash or lingering form. */
function potionItemNameFor(potion, lingering) {
  const form = lingering ? 'lingering_potion' : 'splash_potion';
  try {
    const parsed = potion && potion !== 'water' ? potion : null;
    if (!parsed) return form;
    const name = `${form}_${parsed}`;
    return itemExists(name) ? name : form;
  } catch { return form; }
}

/** Potion effects for a delivery form, in this module's normalized shape. */
function effectsFromPotion(potion, form) {
  if (!potion) return null;
  let list;
  try { list = potionEffectsFor(potion, form); } catch { list = null; }
  return normalizeEffects(list);
}

/** Effects carried by a tipped-arrow / splash-potion *item* name. */
function effectsFromItem(itemName, potionOpt, form) {
  if (typeof potionOpt === 'string') return effectsFromPotion(resolvePotion(potionOpt, itemName), form);
  if (typeof itemName !== 'string') return null;
  let parsed = null;
  try { parsed = parsePotionItem(itemName); } catch { parsed = null; }
  if (!parsed) return null;
  return effectsFromPotion(parsed.potion, form);
}

/** Tint for a potion projectile's trail, or null when it has none. */
function potionColorFor(itemName, potionOpt) {
  let id = null;
  if (typeof potionOpt === 'string') id = potionOpt;
  else if (typeof itemName === 'string') {
    try { const p = parsePotionItem(itemName); if (p) id = p.potion; } catch { id = null; }
  }
  if (!id || id === 'water') return null;
  try { return potionColor(id); } catch { return null; }
}

/**
 * An instant effect scaled by splash distance. Vanilla scales the *magnitude*,
 * not a duration, and effects.js derives the magnitude from the level alone,
 * so the arithmetic is done here and the health moved directly. The numbers
 * match effects.js: Instant Health heals 4x2^level (6 to the undead) and
 * Instant Damage deals 6x2^level (healing the undead by the same).
 */
function applyInstantScaled(entity, name, level, scale) {
  if (scale >= 0.999) { addEffect(entity, name, 1, level | 0); return; }
  if (name !== 'instant_health' && name !== 'instant_damage') {
    addEffect(entity, name, 1, level | 0);
    return;
  }
  const power = Math.pow(2, level | 0);
  const undead = isUndead(entity);
  const heals = name === 'instant_health' ? !undead : undead;
  const base = name === 'instant_health' ? (undead ? 6 : 4) : 6;
  const amount = Math.max(1, Math.round(base * power * scale));
  if (heals) {
    try { entity.heal?.(amount); } catch { /* optional */ }
    particles('heart', entity.x, centreY(entity), entity.z, { count: 4, spread: 0.4 });
  } else {
    try {
      damageEntity(entity, amount, damageSource('magic', null, null,
        { magic: true, bypassArmor: true, bypassCooldown: true, noKnockback: true }));
    } catch { /* optional */ }
  }
}

// ===========================================================================
// Spawning
// ===========================================================================

/**
 * Per-type spawn data. `ctor` builds it; `speed(shooter)` is the muzzle
 * velocity in blocks/second used when the caller passed a bare direction.
 */
const TYPE_DEFS = {
  arrow: { ctor: ArrowEntity, speed: (s) => (isPlayerLike(s) ? 60 : 32) },
  spectral_arrow: { ctor: ArrowEntity, speed: (s) => (isPlayerLike(s) ? 60 : 32), opts: { spectral: true, item: 'spectral_arrow' } },
  tipped_arrow: { ctor: ArrowEntity, speed: (s) => (isPlayerLike(s) ? 60 : 32), opts: { item: 'tipped_arrow' } },
  trident: { ctor: TridentEntity, speed: () => 50 },
  snowball: { ctor: SnowballEntity, speed: () => 30 },
  egg: { ctor: EggEntity, speed: () => 30 },
  ender_pearl: { ctor: EnderPearlEntity, speed: () => 30 },
  experience_bottle: { ctor: ExperienceBottleEntity, speed: () => 21 },
  splash_potion: { ctor: ThrownPotion, speed: () => 25 },
  lingering_potion: { ctor: ThrownPotion, speed: () => 25, opts: { lingering: true } },
  fireball: { ctor: LargeFireball, speed: () => 12 },
  small_fireball: { ctor: SmallFireball, speed: () => 12 },
  dragon_fireball: { ctor: DragonFireball, speed: () => 12 },
  wither_skull: { ctor: WitherSkull, speed: () => 12 },
  wind_charge: { ctor: WindCharge, speed: () => 30 },
  llama_spit: { ctor: LlamaSpit, speed: () => 30 },
  shulker_bullet: { ctor: ShulkerBullet, speed: () => 8 },
  fishing_bobber: { ctor: FishingBobber, speed: () => 30 },
  firework_rocket: { ctor: FireworkRocket, speed: () => 10 },
  eye_of_ender: { ctor: EnderEye, speed: () => 10 },
  end_crystal: { ctor: EndCrystal, speed: () => 0 },
};

/** Every projectile type name `spawnProjectile` understands. */
export const PROJECTILE_TYPES = Object.freeze(Object.keys(TYPE_DEFS));

/**
 * Reads a caller's direction/velocity vector.
 *
 * Callers in this project pass three different things: a unit direction
 * (mobs.js, ai.js), a blocks-per-tick velocity (items.js) and a
 * blocks-per-second velocity (combat.js). Magnitude tells them apart.
 */
function resolveLaunch(def, shooter, dx, dy, dz, opts) {
  let nx = dx || 0, ny = dy || 0, nz = dz || 0;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-6) {
    if (shooter && typeof shooter.getLookVec === 'function') {
      const v = shooter.getLookVec();
      nx = v.x; ny = v.y; nz = v.z;
    } else { nx = 0; ny = 1; nz = 0; }
  } else { nx /= len; ny /= len; nz /= len; }

  let speed;
  const o = opts || {};
  if (typeof o.speed === 'number' && o.speed > 0) {
    speed = o.speed >= SECONDS_LIMIT ? o.speed : o.speed * TICKS_PER_SECOND;
  } else if (len >= SECONDS_LIMIT) {
    speed = len;
  } else if (len > DIR_LIMIT) {
    speed = len * TICKS_PER_SECOND;
  } else {
    speed = def.speed(shooter);
  }
  if (typeof o.power === 'number' && o.power > 0 && o.power <= 1 && len <= DIR_LIMIT && o.speed === undefined) {
    // A bare direction plus a bow charge still deserves the charge scaling.
    speed *= Math.max(0.15, o.power);
  }
  return { nx, ny, nz, speed };
}

/**
 * Creates a projectile, points it, and adds it to the world.
 *
 * @param {string} type one of `PROJECTILE_TYPES`
 * @param {object} world the world to spawn into
 * @param {object|null} shooter whoever fired it (may be null, e.g. a dispenser)
 * @param {number} x @param {number} y @param {number} z spawn position
 * @param {number} dx @param {number} dy @param {number} dz direction or velocity
 * @param {object} [opts] per-type options (damage, item, potion, effects, ...)
 * @returns {Projectile|null} the spawned entity, or null when it could not be made
 */
export function spawnProjectile(type, world, shooter, x, y, z, dx, dy, dz, opts = {}) {
  const o = opts || {};
  const w = world || (shooter && shooter.world) || Game.world;
  if (!w) return null;

  const key = typeof type === 'string' ? type : 'arrow';
  let def = TYPE_DEFS[key];
  if (!def) {
    // Unknown names degrade to the closest thing rather than throwing.
    if (key.indexOf('arrow') >= 0) def = TYPE_DEFS.arrow;
    else if (key.indexOf('potion') >= 0) def = TYPE_DEFS.splash_potion;
    else if (key.indexOf('fireball') >= 0) def = TYPE_DEFS.small_fireball;
    else def = TYPE_DEFS.snowball;
  }

  const merged = Object.assign({}, def.opts || null, o);
  if (!merged.owner && shooter) merged.owner = shooter;
  if (!merged.shooter && shooter) merged.shooter = shooter;

  // Tridents and bows carry their enchantments on the stack still in hand.
  const held = heldOf(shooter);
  if (key === 'trident') {
    if (held && held.item === (merged.item || 'trident')) {
      if (merged.stack === undefined) merged.stack = held;
      if (merged.loyalty === undefined) merged.loyalty = ench(held, 'loyalty');
      if (merged.channeling === undefined) merged.channeling = ench(held, 'channeling');
      if (merged.impaling === undefined) merged.impaling = ench(held, 'impaling');
      if (merged.riptide === undefined) merged.riptide = ench(held, 'riptide');
    }
  }

  const launch = resolveLaunch(def, shooter, dx, dy, dz, merged);

  let p;
  try { p = new def.ctor(w, x, y, z, merged); }
  catch (e) { console.error('[projectiles] could not create', key, e); return null; }

  if (typeof p.setOwner === 'function') p.setOwner(shooter || merged.owner || null);
  if (typeof p.launch === 'function') p.launch(launch.nx, launch.ny, launch.nz, launch.speed);
  if (typeof p.configureDamage === 'function') p.configureDamage(merged, launch.speed);
  else if (merged.damage !== undefined) p.damage = merged.damage;

  // Riptide never actually leaves your hand: it throws *you*, and the trident
  // turns straight round and comes back.
  if (key === 'trident' && (merged.riptide | 0) > 0 && shooter && typeof p.startReturn === 'function') {
    const wet = shooter.inWater || shooter.submerged ||
      (w.isRainingAt && w.isRainingAt(Math.floor(shooter.x), Math.floor(shooter.y), Math.floor(shooter.z)));
    if (wet) {
      const boost = 12 + (merged.riptide | 0) * 5;
      shooter.vx += launch.nx * boost;
      shooter.vy += launch.ny * boost + 3;
      shooter.vz += launch.nz * boost;
      shooter.onGround = false;
      shooter.fallDistance = 0;
      playAt(w, 'trident_riptide', shooter.x, shooter.y, shooter.z, 1, 1);
      particles('cloud', shooter.x, shooter.y + 1, shooter.z, { count: 16, spread: 0.8 });
      p.startReturn();
    }
  }

  try { w.addEntity(p); } catch (e) { console.error('[projectiles] addEntity failed', key, e); return null; }
  Game.emit('projectilespawn', p);
  return p;
}

/**
 * Bats a projectile away from whoever hit it: a ghast fireball punched back at
 * its owner, a shulker bullet swatted out of the air.
 * @param {object} projectile the thing in flight
 * @param {object} byEntity whoever deflected it
 * @returns {boolean} true when the projectile actually turned around
 */
export function deflect(projectile, byEntity) {
  if (!projectile || projectile.removed) return false;
  if (projectile.deflectable === false) return false;

  // combat.js owns the canonical maths; fall back to a local bounce when it is
  // unavailable for any reason.
  let ok = false;
  try { ok = deflectProjectile(projectile, byEntity, { power: 1, reown: true }); }
  catch { ok = false; }
  const handled = ok;
  if (!ok) {
    const sp = Math.hypot(projectile.vx || 0, projectile.vy || 0, projectile.vz || 0) || 20;
    let nx, ny, nz;
    if (byEntity && typeof byEntity.yaw === 'number') {
      const cp = Math.cos(byEntity.pitch || 0);
      nx = -Math.sin(byEntity.yaw || 0) * cp;
      ny = -Math.sin(byEntity.pitch || 0);
      nz = Math.cos(byEntity.yaw || 0) * cp;
    } else {
      const l = sp || 1;
      nx = -(projectile.vx || 0) / l; ny = -(projectile.vy || 0) / l; nz = -(projectile.vz || 0) / l;
    }
    projectile.vx = nx * sp; projectile.vy = ny * sp; projectile.vz = nz * sp;
    if (byEntity) { projectile.owner = byEntity; projectile.ownerId = byEntity.id; }
    ok = true;
  }

  projectile.inGround = false;
  projectile.stuck = false;
  projectile.life = 0;
  projectile.ownerImmuneTicks = OWNER_IMMUNE_TICKS;
  projectile.piercedIds = null;
  projectile.deflectedBy = byEntity || null;
  if (typeof projectile.faceVelocity === 'function') projectile.faceVelocity();
  // Whoever swatted it now owns it, so the ghast is a legal target again.
  if (byEntity) { projectile.owner = byEntity; projectile.ownerId = byEntity.id; }
  if (!handled) {
    playAt(projectile.world, 'arrow_hit', projectile.x, projectile.y, projectile.z, 0.7, 1.5);
    particles('crit', projectile.x, projectile.y, projectile.z, { count: 6, spread: 0.25 });
  }
  return true;
}

// ===========================================================================
// Registry
// ===========================================================================

registerEntityType('projectile', Projectile);
registerEntityType('arrow', ArrowEntity);
registerEntityType('spectral_arrow', ArrowEntity);
registerEntityType('tipped_arrow', ArrowEntity);
registerEntityType('trident', TridentEntity);
registerEntityType('snowball', SnowballEntity);
registerEntityType('egg', EggEntity);
registerEntityType('ender_pearl', EnderPearlEntity);
registerEntityType('experience_bottle', ExperienceBottleEntity);
registerEntityType('splash_potion', ThrownPotion);
registerEntityType('lingering_potion', ThrownPotion);
registerEntityType('fireball', LargeFireball);
registerEntityType('small_fireball', SmallFireball);
registerEntityType('dragon_fireball', DragonFireball);
registerEntityType('wither_skull', WitherSkull);
registerEntityType('wind_charge', WindCharge);
registerEntityType('llama_spit', LlamaSpit);
registerEntityType('shulker_bullet', ShulkerBullet);
registerEntityType('fishing_bobber', FishingBobber);
registerEntityType('firework_rocket', FireworkRocket);
registerEntityType('eye_of_ender', EnderEye);
registerEntityType('end_crystal', EndCrystal);
registerEntityType('area_effect_cloud', AreaEffectCloud);

export default spawnProjectile;
