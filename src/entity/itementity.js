// ============================================================================
// itementity.js - The "things that are not mobs" half of the entity system.
//
//   ItemEntity     a dropped stack: bobs, spins, merges, floats, burns, and
//                  flies into a nearby player's inventory
//   XPOrb          experience: merges, is pulled in from 8 blocks, spends
//                  itself on Mending before it ever reaches the bar
//   FallingBlock   sand / gravel / anvils / concrete powder in mid-air
//   TNTEntity      primed TNT: 4-second fuse, then a power-4 blast that chains
//   LeashKnot / ItemFrame / Painting / ArmorStand / EndCrystal
//                  the small decoration family
//
// Units follow the rest of the project: positions in blocks, velocities in
// **blocks per second** (vanilla's per-tick numbers x20), durations in ticks.
// `update(dt)` runs per frame and owns physics; `tick()` runs at 20 Hz and owns
// discrete logic (fuses, merging, pickup, despawn).
//
// Every cross-module call in here is either optional-chained or wrapped, so an
// unfinished neighbour (particles.js, the entity renderer, loot tables) can
// never take the whole world down with it.
// ============================================================================
import {
  WORLD_HEIGHT, GRAVITY, ID_MASK,
  FACE_DIRS, FACE_OPPOSITE, FACE_NORTH, FACE_SOUTH, FACE_WEST, FACE_EAST,
} from '../core/constants.js';
import { AABB, clamp, prettyName } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { Game } from '../core/game.js';
import { BLOCKS, getBlock, blockByName } from '../world/blocks.js';
import { Entity, LivingEntity, registerEntityType, EQUIP } from './entity.js';
import {
  stack as mkStack, isEmpty, sameItem, copyStack, maxStackSize,
} from '../item/inventory.js';
import { getItem } from '../item/items.js';
import { explode, damageEntity, damageSource } from './combat.js';
import { mendingRepair, getEnchant } from '../item/enchanting.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Ticks a fresh drop refuses to be picked up (half a second). */
export const DEFAULT_PICKUP_DELAY = 10;
/** Sentinel pickup delay meaning "never" (vanilla uses the same magic number). */
export const NEVER_PICKUP = 32767;
/** Five minutes, in ticks: how long loose items and orbs survive. */
export const DESPAWN_TICKS = 6000;
/** How close a player has to be before a drop starts flying at them. */
export const ITEM_ATTRACT_RANGE = 1.5;
/** XP orbs reach a lot further than items do. */
export const ORB_ATTRACT_RANGE = 8;
/** Default TNT fuse, in ticks. */
export const TNT_FUSE = 80;
/** Blast power of primed TNT. */
export const TNT_POWER = 4;
/** Blast power of an end crystal. */
export const END_CRYSTAL_POWER = 6;
/** Vanilla item drag: 0.98 of the velocity survives each tick. */
const ITEM_DRAG = 0.98;
/** Gravity for the "light" entities (items, orbs, TNT, falling blocks). */
const ITEM_GRAVITY = GRAVITY * 0.5;      // 16 blocks/s^2 == vanilla 0.04/tick^2
const ORB_GRAVITY = GRAVITY * 0.375;     // 12 blocks/s^2 == vanilla 0.03/tick^2

// ---------------------------------------------------------------------------
// Block ids we care about. Resolved once, at module load, from names only.
// ---------------------------------------------------------------------------
const idOf = (name) => { const d = blockByName(name); return d ? d.id : -1; };

const ID_WATER = idOf('water');
const ID_FIRE = idOf('fire');
const ID_SOUL_FIRE = idOf('soul_fire');
const ID_TNT = idOf('tnt');

/** concrete powder id -> the concrete it hardens into. */
const CONCRETE_OF = new Map();
/** Anvil id -> the more battered anvil it becomes when it lands, or 0. */
const ANVIL_NEXT = new Map();
/** Every anvil id, so falling anvils know to hurt what they land on. */
const ANVIL_IDS = new Set();
/** Fence-ish blocks a leash knot may be tied to. */
const FENCE_IDS = new Set();

(function buildBlockTables() {
  for (let i = 0; i < BLOCKS.length; i++) {
    const def = BLOCKS[i];
    if (!def || def.id !== i || !def.name) continue;
    const name = def.name;
    if (name.endsWith('_concrete_powder')) {
      const solid = blockByName(name.slice(0, -'_powder'.length));
      if (solid) CONCRETE_OF.set(def.id, solid.id);
    }
    if (name === 'anvil' || name === 'chipped_anvil' || name === 'damaged_anvil') ANVIL_IDS.add(def.id);
    if (def.model === 'fence' || name.endsWith('_fence')) FENCE_IDS.add(def.id);
  }
  const chain = ['anvil', 'chipped_anvil', 'damaged_anvil'];
  for (let i = 0; i < chain.length; i++) {
    const cur = blockByName(chain[i]);
    if (!cur) continue;
    const next = i + 1 < chain.length ? blockByName(chain[i + 1]) : null;
    ANVIL_NEXT.set(cur.id, next ? next.id : 0);
  }
})();

/**
 * Items that shrug off fire and lava. Vanilla marks these `isFireResistant` on
 * the item; this project's item defs have no such flag, so the family list
 * lives here instead.
 */
const FIREPROOF_ITEMS = new Set([
  'netherite_ingot', 'netherite_scrap', 'netherite_block', 'ancient_debris',
  'netherite_sword', 'netherite_pickaxe', 'netherite_axe', 'netherite_shovel', 'netherite_hoe',
  'netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots',
  'netherite_upgrade_smithing_template', 'nether_star', 'lava_bucket',
]);

/** Damage source types a dropped item or an orb simply ignores. */
const HARMLESS_TO_ITEMS = new Set([
  'drown', 'dry_out', 'fall', 'starve', 'in_wall', 'suffocate', 'sweet_berry_bush',
  'magic', 'wither', 'poison', 'freeze', 'thorns', 'sonic_boom', 'dragon_breath',
]);

/** Damage source types that wipe a dropped item out instantly. */
const LETHAL_TO_ITEMS = new Set(['cactus', 'out_of_world', 'void', 'explosion', 'lava', 'on_fire', 'fire', 'hot_floor']);

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** One module-level RNG so drop spread is cheap and never allocates. */
const RAND = new RNG(0x17e4b0b);

const _boxA = new AABB();
const _boxB = new AABB();

/** Positional sound that tolerates a missing or half-built audio engine. */
function playAt(world, name, x, y, z, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || typeof a.playAt !== 'function') return;
  try { a.playAt(name, x, y, z, volume, pitch); } catch { /* audio is optional */ }
}

/** Particle burst that tolerates a missing particle system. */
function particles(type, x, y, z, opts) {
  const p = Game.particles;
  if (!p || typeof p.spawn !== 'function') return;
  try { p.spawn(type, x, y, z, opts || {}); } catch { /* particles are optional */ }
}

/** `place_<material>` for a block, falling back to stone. */
function placeSound(def) {
  return 'place_' + ((def && def.sound) || 'stone');
}

/** True when the id is air, a fluid, fire or otherwise replaceable and soft. */
function canFallThrough(id) {
  if (id === 0) return true;
  const def = getBlock(id);
  if (!def) return true;
  if (def.liquid) return true;
  if (id === ID_FIRE || id === ID_SOUL_FIRE) return true;
  return !!def.replaceable && def.collision === 'none';
}

/** True when a falling block may settle into this spot. */
function canReplaceOnLanding(id) {
  if (id === 0) return true;
  const def = getBlock(id);
  if (!def) return true;
  if (def.liquid) return true;
  return !!def.replaceable;
}

/** True when the block at (x,y,z) is water. */
function isWaterAt(world, x, y, z) {
  const def = getBlock(world.getBlock(x, y, z));
  return !!def && def.liquid === 'water';
}

/** Whether an entity should be able to collect drops right now. */
function canCollect(e) {
  if (!e || e.removed || e.dead) return false;
  if (e.gameMode === 'spectator') return false;
  return true;
}

/** Nearest player-ish entity, tolerating a world without the helper. */
function nearestPlayer(world, x, y, z, radius) {
  if (!world) return null;
  try {
    if (typeof world.nearestPlayer === 'function') return world.nearestPlayer(x, y, z, radius);
    if (typeof world.nearestEntity === 'function') {
      return world.nearestEntity(x, y, z, radius, (e) => e && (e.isPlayer || e.type === 'player'));
    }
  } catch { /* fall through */ }
  const p = Game.player;
  if (p && !p.removed && p.world === world) {
    const dx = p.x - x, dy = p.y - y, dz = p.z - z;
    if (dx * dx + dy * dy + dz * dz <= radius * radius) return p;
  }
  return null;
}

/**
 * `combat.damageEntity` never calls `entity.hurt()` - it edits health directly
 * - but it *does* consult `entity.def.onHurt(self, amount, src)` and treats a
 * `false` result as "this hit did nothing". That hook is therefore the only way
 * a non-mob entity can react to being punched, so every class below that wants
 * custom behaviour installs one that simply forwards to its own `hurt()`.
 *
 * The def deliberately carries a name but no `category` or `drops`, so nothing
 * that scans for mobs mistakes one of these for a spawnable creature.
 */
function damageHookDef(name) {
  return {
    name,
    notAMob: true,
    onHurt: (self, amount, src) => {
      try { self.hurt(amount, src); } catch (e) { console.error('[itementity] hurt hook failed', e); }
      return false;      // this module has already resolved the hit
    },
  };
}

/** True when this stack survives fire and lava. */
function stackIsFireproof(s) {
  if (isEmpty(s)) return false;
  if (s.fireproof) return true;
  return FIREPROOF_ITEMS.has(s.item);
}

// ===========================================================================
// ItemEntity
// ===========================================================================

/**
 * A dropped item stack lying in the world.
 *
 * 0.25-cube hitbox, a 10-tick pickup delay, merges with identical stacks that
 * roll into it, floats up through water, burns in fire and lava, dies to
 * cactus and explosions, and is sucked into a player who walks within 1.5
 * blocks. A stack that does not entirely fit stays on the ground.
 */
export class ItemEntity extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {object|null} stack the item stack (copied, never aliased)
   */
  constructor(world, x, y, z, stack = null) {
    super(world, x, y, z);
    this.type = 'item';
    this.model = 'item';
    this.display = 'Item';

    this.width = 0.25;
    this.height = 0.25;
    this.eyeHeight = 0.125;

    /** @type {object|null} */
    this.stack = isEmpty(stack) ? null : copyStack(stack);

    this.pickupDelay = DEFAULT_PICKUP_DELAY;
    this.lifespan = DESPAWN_TICKS;
    /** Entity id of whoever threw this. Informational; used by /clear filters. */
    this.thrower = null;
    /** Entity id allowed to grab this before the pickup delay expires. */
    this.owner = null;

    this.health = 5;
    this.maxHealth = 5;
    this.gravity = ITEM_GRAVITY;
    this.drag = ITEM_DRAG;
    this.dragY = ITEM_DRAG;
    this.groundFriction = ITEM_DRAG;     // x block slipperiness, like vanilla
    this.stepHeight = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.canPickUpLoot = false;

    // Presentation state the renderer reads: every drop bobs and spins on its
    // own phase so a pile of them does not pulse in lockstep.
    this.hoverStart = RAND.next() * Math.PI * 2;
    this.bobOffset = 0;
    this.spinAngle = this.hoverStart;
    this.renderScale = 1;

    this._attracted = false;
    this._mergeTimer = 1 + (this.id & 7);
    this.def = damageHookDef('item');
    this.refreshDisplay();
  }

  /** Replaces the carried stack (copied). */
  setStack(s) {
    this.stack = isEmpty(s) ? null : copyStack(s);
    this.refreshDisplay();
    return this;
  }

  /** The stack this entity is carrying, or null. */
  getStack() { return isEmpty(this.stack) ? null : this.stack; }

  /** Keeps `display` in step with the carried item, for F3 and chat. */
  refreshDisplay() {
    this.display = isEmpty(this.stack) ? 'Item' : prettyName(this.stack.item);
  }

  /** @override adds water buoyancy ahead of the shared physics step. */
  update(dt) {
    if (this.removed) return;
    if (dt > 0) this.applyBuoyancy(dt);
    super.update(dt);
    // Bob/spin phases advance with real time so the renderer can interpolate.
    if (dt > 0) {
      this.spinAngle += dt * 1.2;
      this.bobOffset = Math.sin(this.hoverStart + this.spinAngle * 2.2) * 0.06;
    }
  }

  /**
   * Loose items float. Submerged ones climb briskly; ones already breaking the
   * surface only get enough lift to bob there instead of sinking.
   */
  applyBuoyancy(dt) {
    if (!this.inWater) return;
    const rise = this.submerged ? 1.7 : 0.4;
    if (this.vy < rise) this.vy = Math.min(rise, this.vy + 22 * dt);
    this.fallDistance = 0;
  }

  /** @override 20 Hz logic: delay, merging, pickup and despawn. */
  tick() {
    if (this.removed) return;
    if (isEmpty(this.stack)) { this.remove(); return; }

    super.tick();
    if (this.removed) return;

    if (this.pickupDelay > 0 && this.pickupDelay !== NEVER_PICKUP) this.pickupDelay--;

    // Merging is not free, so it runs on a stagger rather than every tick.
    if (--this._mergeTimer <= 0) {
      this._mergeTimer = 10;
      this.tryMerge();
      if (this.removed) return;
    }

    this.tickPickup();
    if (this.removed) return;

    // Lava eats items even when they are only skimming the surface, and the
    // shared fire tick would take five whole seconds to finish the job.
    if (this.inLava && !stackIsFireproof(this.stack)) { this.burnUp(); return; }

    if (this.lifespan > 0 && this.age >= this.lifespan) {
      particles('smoke', this.x, this.y + 0.15, this.z, { count: 2, size: 0.4 });
      this.remove();
    }
  }

  /**
   * Absorbs identical stacks lying within half a block. The absorber keeps the
   * younger of the two ages, so a pile of drops does not vanish early.
   */
  tryMerge() {
    const world = this.world;
    if (!world || this.removed || isEmpty(this.stack)) return;
    if (this.pickupDelay === NEVER_PICKUP) return;
    const max = maxStackSize(this.stack);
    if (max <= 1 || this.stack.count >= max) return;

    const box = this.aabb(_boxA).expand(0.5, 0.05, 0.5);
    let list;
    try {
      list = world.entitiesInAABB(box, (e) => (
        e !== this && !e.removed && e.type === 'item' && e.pickupDelay !== NEVER_PICKUP && !isEmpty(e.stack)
      ));
    } catch { return; }
    if (!list || list.length === 0) return;

    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other.removed || isEmpty(other.stack)) continue;
      if (!sameItem(this.stack, other.stack)) continue;
      const room = Math.min(max - (this.stack.count | 0), other.stack.count | 0);
      if (room <= 0) continue;

      this.stack.count += room;
      other.stack.count -= room;
      this.pickupDelay = Math.max(this.pickupDelay, other.pickupDelay);
      if (other.age < this.age) this.age = other.age;
      if (other.stack.count <= 0) other.remove();
      if (this.stack.count >= max) break;
    }
  }

  /** Pulls the drop toward a nearby player and hands it over on contact. */
  tickPickup() {
    const world = this.world;
    if (!world || isEmpty(this.stack)) return;
    if (this.pickupDelay === NEVER_PICKUP) { this.setAttracted(false); return; }

    const player = nearestPlayer(world, this.x, this.y, this.z, ITEM_ATTRACT_RANGE + 1.5);
    if (!canCollect(player)) { this.setAttracted(false); return; }

    // An owner (a villager trade payout, say) skips the delay; everyone else
    // has to wait it out so a thrown stack does not snap straight back.
    if (this.pickupDelay > 0 && !(this.owner != null && player.id === this.owner)) {
      this.setAttracted(false);
      return;
    }

    const tx = player.x;
    const ty = player.y + (player.height || 1.8) * 0.35;
    const tz = player.z;
    const dx = tx - this.x;
    const dy = ty - (this.y + this.height * 0.5);
    const dz = tz - this.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (d > ITEM_ATTRACT_RANGE) { this.setAttracted(false); return; }
    if (d < 1.0) { this.collectBy(player); return; }

    // Accelerate: the closer it gets, the harder it is yanked in.
    this.setAttracted(true);
    const inv = 1 / Math.max(d, 1e-4);
    const speed = 3.5 + (ITEM_ATTRACT_RANGE - d) * 4;
    const k = 0.45;
    this.vx += (dx * inv * speed - this.vx) * k;
    this.vy += (dy * inv * speed - this.vy) * k;
    this.vz += (dz * inv * speed - this.vz) * k;
  }

  /** Toggles the "flying at a player" state, which suspends gravity + drag. */
  setAttracted(on) {
    if (this._attracted === on) return;
    this._attracted = on;
    this.noGravity = on;
    this.frictionEnabled = !on;
  }

  /**
   * Hands the stack to a collector. Whatever does not fit stays on the ground
   * as a smaller drop, exactly like vanilla's full-inventory behaviour.
   * @returns {boolean} true when at least one item changed hands
   */
  collectBy(collector) {
    if (!collector || isEmpty(this.stack)) return false;
    const before = this.stack.count | 0;
    let left = this.stack;
    let handled = false;

    if (typeof collector.giveItem === 'function') {
      try { left = collector.giveItem(this.stack); handled = true; } catch { left = this.stack; handled = false; }
    } else if (collector.inventory && typeof collector.inventory.add === 'function') {
      try { left = collector.inventory.add(this.stack); handled = true; } catch { left = this.stack; handled = false; }
    }
    if (!handled) { this.pickupDelay = 10; this.setAttracted(false); return false; }

    const remaining = isEmpty(left) ? 0 : (left.count | 0);
    const taken = before - remaining;
    if (taken <= 0) {
      // Inventory full: back off for half a second before trying again.
      this.pickupDelay = 10;
      this.setAttracted(false);
      return false;
    }

    // `giveItem` on the player already makes the pop; anything else needs one.
    if (typeof collector.giveItem !== 'function') {
      playAt(this.world, 'item_pickup', this.x, this.y, this.z, 0.25, 1.5 + RAND.next() * 0.4);
      Game.emit('itempickup', this.stack, collector);
    }

    if (remaining <= 0) {
      this.stack = null;
      this.setAttracted(false);
      this.remove();
    } else {
      // Whatever would not fit stays on the ground as a smaller drop.
      this.stack = left;
      this.refreshDisplay();
      this.pickupDelay = 10;
      this.setAttracted(false);
    }
    return true;
  }

  /** @override items ignore most damage and are wiped out by the rest. */
  hurt(amount, source = null) {
    if (this.removed) return false;
    if (this.invulnerable) return false;
    if (!(amount > 0)) return false;

    const type = source && source.type ? source.type : 'generic';
    if (HARMLESS_TO_ITEMS.has(type)) return false;

    const fiery = !!(source && source.fire) || type === 'on_fire' || type === 'fire' ||
      type === 'lava' || type === 'hot_floor';
    if (fiery && stackIsFireproof(this.stack)) { this.fireTicks = 0; return false; }

    if (LETHAL_TO_ITEMS.has(type) || (source && source.explosion)) {
      if (fiery) this.burnUp(); else this.destroyed();
      return true;
    }

    this.health -= amount;
    if (this.health <= 0) { this.destroyed(); }
    return true;
  }

  /** Puff of smoke, then gone. */
  burnUp() {
    particles('smoke', this.x, this.y + 0.15, this.z, { count: 4, size: 0.5 });
    particles('flame', this.x, this.y + 0.1, this.z, { count: 2 });
    this.destroyed();
  }

  /** Removes the drop without any of the living-entity death ceremony. */
  destroyed() {
    if (this.removed) return;
    this.stack = null;
    this.health = 0;
    this.remove();
  }

  /** @override loose items never take fall damage. */
  fall(_distance) { /* items just land */ }

  /** @override */
  kill(_source) { this.destroyed(); }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'item';
    o.stack = isEmpty(this.stack) ? null : copyStack(this.stack);
    o.pickupDelay = this.pickupDelay;
    o.lifespan = this.lifespan;
    o.hoverStart = this.hoverStart;
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.stack !== undefined) this.stack = isEmpty(obj.stack) ? null : copyStack(obj.stack);
    if (obj.pickupDelay !== undefined) this.pickupDelay = obj.pickupDelay | 0;
    if (obj.lifespan !== undefined) this.lifespan = obj.lifespan | 0;
    if (obj.hoverStart !== undefined) this.hoverStart = obj.hoverStart;
    this.refreshDisplay();
    return this;
  }
}

// ===========================================================================
// XPOrb
// ===========================================================================

/** Vanilla's orb split table, largest chunk that fits in `value`. */
function orbValue(value) {
  if (value >= 2477) return 2477;
  if (value >= 1237) return 1237;
  if (value >= 617) return 617;
  if (value >= 307) return 307;
  if (value >= 149) return 149;
  if (value >= 73) return 73;
  if (value >= 37) return 37;
  if (value >= 17) return 17;
  if (value >= 7) return 7;
  if (value >= 3) return 3;
  return 1;
}

/** Visual tier 0..10 for an orb, driving its size and colour in the renderer. */
export function orbTier(value) {
  if (value >= 2477) return 10;
  if (value >= 1237) return 9;
  if (value >= 617) return 8;
  if (value >= 307) return 7;
  if (value >= 149) return 6;
  if (value >= 73) return 5;
  if (value >= 37) return 4;
  if (value >= 17) return 3;
  if (value >= 7) return 2;
  if (value >= 3) return 1;
  return 0;
}

/**
 * A floating ball of experience.
 *
 * Merges with orbs it bumps into, is pulled toward a player from 8 blocks out,
 * and spends itself repairing Mending gear (2 durability per point) before the
 * remainder reaches the XP bar. Despawns after five minutes.
 */
export class XPOrb extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {number} amount experience points this orb is worth
   */
  constructor(world, x, y, z, amount = 1) {
    super(world, x, y, z);
    this.type = 'xp_orb';
    this.model = 'xp_orb';
    this.display = 'Experience Orb';

    this.width = 0.5;
    this.height = 0.5;
    this.eyeHeight = 0.25;

    this.amount = Math.max(1, Math.floor(amount) || 1);
    this.tier = orbTier(this.amount);
    this.renderScale = 0.6 + this.tier * 0.06;

    this.health = 5;
    this.maxHealth = 5;
    this.gravity = ORB_GRAVITY;
    this.drag = ITEM_DRAG;
    this.dragY = ITEM_DRAG;
    this.groundFriction = ITEM_DRAG;
    this.stepHeight = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;

    this.lifespan = DESPAWN_TICKS;
    this.pickupDelay = 0;
    this.hoverStart = RAND.next() * Math.PI * 2;
    this.bobOffset = 0;
    this.spinAngle = this.hoverStart;

    this._attracted = false;
    this._mergeTimer = 4 + (this.id & 15);
    this.def = damageHookDef('xp_orb');
  }

  /** Keeps the tier and render scale in step with the stored value. */
  setAmount(n) {
    this.amount = Math.max(1, Math.floor(n) || 1);
    this.tier = orbTier(this.amount);
    this.renderScale = 0.6 + this.tier * 0.06;
    return this;
  }

  /** @override adds buoyancy and the bob phase. */
  update(dt) {
    if (this.removed) return;
    if (dt > 0 && this.inWater) {
      const rise = this.submerged ? 1.4 : 0.35;
      if (this.vy < rise) this.vy = Math.min(rise, this.vy + 20 * dt);
      this.fallDistance = 0;
    }
    super.update(dt);
    if (dt > 0) {
      this.spinAngle += dt * 2.6;
      this.bobOffset = Math.sin(this.hoverStart + this.spinAngle) * 0.05;
    }
  }

  /** @override */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;

    if (this.pickupDelay > 0) this.pickupDelay--;

    if (--this._mergeTimer <= 0) {
      this._mergeTimer = 20;
      this.tryMerge();
      if (this.removed) return;
    }

    this.tickAttract();
    if (this.removed) return;

    if ((this.age & 3) === 0) {
      particles('enchant', this.x, this.y + 0.25, this.z, { count: 1, size: 0.3, life: 0.4 });
    }

    if (this.lifespan > 0 && this.age >= this.lifespan) this.remove();
  }

  /** Absorbs orbs within half a block so big drops collapse into few orbs. */
  tryMerge() {
    const world = this.world;
    if (!world || this.removed) return;
    if (this.amount >= 2477) return;
    const box = this.aabb(_boxA).expand(0.5, 0.25, 0.5);
    let list;
    try {
      list = world.entitiesInAABB(box, (e) => e !== this && !e.removed && e.type === 'xp_orb');
    } catch { return; }
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other.removed || !(other.amount > 0)) continue;
      // Strictly one-directional: the *younger* orb absorbs, which also means
      // the merged pile inherits the longer remaining lifetime. The id acts as
      // a tie-break so two same-age orbs never try to eat each other.
      if (other.age > this.age || (other.age === this.age && other.id > this.id)) {
        this.setAmount(this.amount + other.amount);
        other.remove();
        if (this.amount >= 2477) break;
      }
    }
  }

  /** Homes in on the nearest player and pays out on contact. */
  tickAttract() {
    const world = this.world;
    if (!world || this.pickupDelay > 0) { this.setAttracted(false); return; }
    const player = nearestPlayer(world, this.x, this.y, this.z, ORB_ATTRACT_RANGE);
    if (!canCollect(player)) { this.setAttracted(false); return; }

    const tx = player.x;
    const ty = player.y + (player.height || 1.8) * 0.4;
    const tz = player.z;
    const dx = tx - this.x;
    const dy = ty - (this.y + this.height * 0.5);
    const dz = tz - this.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > ORB_ATTRACT_RANGE) { this.setAttracted(false); return; }
    if (d < 1.0) { this.award(player); return; }

    // Vanilla's inverse-square pull, converted from blocks/tick to blocks/s.
    this.setAttracted(true);
    const inv = 1 / Math.max(d, 1e-4);
    const t = 1 - d / ORB_ATTRACT_RANGE;
    const accel = 2 + t * t * 24;
    this.vx += dx * inv * accel * 0.05;
    this.vy += dy * inv * accel * 0.05;
    this.vz += dz * inv * accel * 0.05;
    const sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy + this.vz * this.vz);
    if (sp > 14) { const k = 14 / sp; this.vx *= k; this.vy *= k; this.vz *= k; }
  }

  /** Suspends gravity while the orb is homing, so it flies in a straight line. */
  setAttracted(on) {
    if (this._attracted === on) return;
    this._attracted = on;
    this.noGravity = on;
    this.frictionEnabled = !on;
    if (!on) this.onGround = false;
  }

  /**
   * Pays the orb out. `Player.addXP` already spends points on Mending gear
   * first; when the collector has no such method the repair is done here so
   * the 2-durability-per-point rule still holds.
   */
  award(player) {
    if (this.removed || !player) return;
    const amount = this.amount;
    let handled = false;

    // Player.addXP already spends the points on Mending gear before the bar
    // sees them, and it may legitimately return 0 when a tool ate the lot - so
    // the fallback keys off "did the call work", not off the return value.
    if (typeof player.addXP === 'function') {
      try { player.addXP(amount); handled = true; } catch { handled = false; }
    }
    if (!handled) {
      const left = repairMendingGear(player, amount);
      if (left > 0) player.xp = (typeof player.xp === 'number' ? player.xp : 0) + left;
    }

    playAt(this.world, 'xp_pickup', this.x, this.y, this.z, 0.3, 1.6 + RAND.next() * 0.3);
    Game.emit('xppickup', amount, player);
    this.amount = 0;
    this.remove();
  }

  /** @override orbs are as fragile as items and ignore the same sources. */
  hurt(amount, source = null) {
    if (this.removed || this.invulnerable || !(amount > 0)) return false;
    const type = source && source.type ? source.type : 'generic';
    if (HARMLESS_TO_ITEMS.has(type)) return false;
    if (LETHAL_TO_ITEMS.has(type) || (source && source.explosion)) { this.remove(); return true; }
    this.health -= amount;
    if (this.health <= 0) this.remove();
    return true;
  }

  /** @override */
  fall(_distance) { /* orbs bounce, they do not bruise */ }

  /** @override */
  kill(_source) { this.remove(); }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'xp_orb';
    o.amount = this.amount;
    o.lifespan = this.lifespan;
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (obj && obj.amount !== undefined) this.setAmount(obj.amount);
    if (obj && obj.lifespan !== undefined) this.lifespan = obj.lifespan | 0;
    return this;
  }
}

/**
 * Spends experience on the wearer's damaged Mending gear.
 * @returns {number} points left over after the repairs
 */
function repairMendingGear(entity, points) {
  let left = Math.max(0, points | 0);
  if (!entity || left <= 0) return left;
  const slots = [EQUIP.MAINHAND, EQUIP.OFFHAND, EQUIP.HEAD, EQUIP.CHEST, EQUIP.LEGS, EQUIP.FEET];
  for (let i = 0; i < slots.length && left > 0; i++) {
    let s = null;
    try { s = typeof entity.getEquipment === 'function' ? entity.getEquipment(slots[i]) : null; } catch { s = null; }
    if (isEmpty(s) || !(s.damage > 0)) continue;
    try {
      if (getEnchant(s, 'mending') <= 0) continue;
      const spent = mendingRepair(s, left);
      if (spent > 0) left -= spent;
    } catch { /* enchantment data is optional */ }
  }
  return left;
}

// ===========================================================================
// FallingBlock
// ===========================================================================

/**
 * Sand, gravel, an anvil or concrete powder in mid-air.
 *
 * Carries the block id and metadata; on landing it puts the block back, or
 * drops it as an item when something already occupies the spot. Anvils bruise
 * whatever they land on (2 per block fallen, capped at 40) and concrete powder
 * hardens into concrete if it lands in - or next to - water.
 */
export class FallingBlock extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {number} blockId @param {number} blockMeta
   */
  constructor(world, x, y, z, blockId = 0, blockMeta = 0) {
    super(world, x, y, z);
    this.type = 'falling_block';
    this.model = 'block';
    this.renderBlock = true;

    this.blockId = blockId & ID_MASK;
    this.blockMeta = blockMeta & 15;
    const def = getBlock(this.blockId);
    this.blockName = def ? def.name : 'stone';
    this.display = def ? def.display : 'Falling Block';

    this.width = 0.98;
    this.height = 0.98;
    this.eyeHeight = 0.49;

    this.health = 5;
    this.maxHealth = 5;
    this.gravity = ITEM_GRAVITY;
    this.drag = ITEM_DRAG;
    this.dragY = ITEM_DRAG;
    this.groundFriction = ITEM_DRAG;
    this.stepHeight = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.fireImmune = true;

    this.fallTime = 0;
    this.startY = y;
    /** How far it has actually dropped, used for the anvil damage formula. */
    this.fallenBlocks = 0;
    this.dropItemOnFail = true;
    this.hurtEntities = ANVIL_IDS.has(this.blockId);
    this.fallHurtAmount = 2;
    this.fallHurtMax = 40;
    this.landed = false;
    this.def = damageHookDef('falling_block');
  }

  /** @override */
  tick() {
    if (this.removed) return;
    if (this.blockId <= 0) { this.remove(); return; }

    this.fallTime++;
    super.tick();
    if (this.removed) return;

    const drop = this.startY - this.y;
    if (drop > this.fallenBlocks) this.fallenBlocks = drop;

    // Concrete powder hardens the moment it touches water, mid-air included.
    if (CONCRETE_OF.has(this.blockId) && this.touchingWater()) {
      this.blockId = CONCRETE_OF.get(this.blockId);
      const def = getBlock(this.blockId);
      this.blockName = def ? def.name : this.blockName;
      particles('splash', this.x, this.y + 0.5, this.z, { count: 6 });
      playAt(this.world, 'fizz', this.x, this.y, this.z, 0.4, 1.2);
    }

    if (this.onGround) { this.land(); return; }

    // A block that has been in the air far too long (stuck in a wall, or the
    // chunk under it unloaded) turns back into an item rather than hanging.
    if (this.fallTime > 600) { this.spill(); this.remove(); }
    if (this.y < -2) this.remove();
  }

  /**
   * True when the block the entity is passing through is water. Deliberately
   * narrower than the landing check below: powder only sets off in mid-air if
   * it actually falls *through* water, not merely past a pool beside it.
   */
  touchingWater() {
    const world = this.world;
    if (!world || ID_WATER < 0) return false;
    if (this.inWater) return true;
    const bx = Math.floor(this.x), bz = Math.floor(this.z);
    const by = Math.floor(this.y + 0.5);
    if (by < 0 || by >= WORLD_HEIGHT) return false;
    return isWaterAt(world, bx, by, bz);
  }

  /** Settles into the world: place the block back, or spill it as an item. */
  land() {
    if (this.landed || this.removed) return;
    this.landed = true;
    const world = this.world;
    if (!world) { this.remove(); return; }

    const bx = Math.floor(this.x);
    const bz = Math.floor(this.z);
    let by = Math.floor(this.y + 0.02);
    if (by < 0) { this.remove(); return; }
    if (by >= WORLD_HEIGHT) by = WORLD_HEIGHT - 1;

    let placeId = this.blockId;
    // Water at the landing spot turns concrete powder solid on the way down.
    if (CONCRETE_OF.has(placeId)) {
      const inWater = isWaterAt(world, bx, by, bz) || isWaterAt(world, bx, by - 1, bz) ||
        isWaterAt(world, bx + 1, by, bz) || isWaterAt(world, bx - 1, by, bz) ||
        isWaterAt(world, bx, by, bz + 1) || isWaterAt(world, bx, by, bz - 1);
      if (inWater) {
        placeId = CONCRETE_OF.get(placeId);
        playAt(world, 'fizz', bx + 0.5, by + 0.5, bz + 0.5, 0.5, 1.1);
        particles('smoke', bx + 0.5, by + 0.7, bz + 0.5, { count: 5 });
      }
    }

    this.damageLandingEntities();

    const targetId = world.getBlock(bx, by, bz);
    const placed = canReplaceOnLanding(targetId) && this.hasSupport(world, bx, by, bz);

    if (placed) {
      try { world.setBlock(bx, by, bz, placeId, this.blockMeta, 3); } catch { /* keep going */ }
      const def = getBlock(placeId);
      playAt(world, placeSound(def), bx + 0.5, by + 0.5, bz + 0.5, 0.7, 0.9 + RAND.next() * 0.2);
      particles('block', bx + 0.5, by + 0.1, bz + 0.5, { count: 8, blockId: placeId, size: 0.5 });
      this.onLandedBlock(world, bx, by, bz, placeId);
    } else if (this.dropItemOnFail) {
      this.spill();
    }

    this.remove();
  }

  /** Anvils chip when they land, and clang doing it. */
  onLandedBlock(world, bx, by, bz, placeId) {
    if (!ANVIL_IDS.has(placeId)) return;
    playAt(world, 'anvil_use', bx + 0.5, by + 0.5, bz + 0.5, 0.8, 0.85 + RAND.next() * 0.2);
    const fallen = Math.max(0, Math.floor(this.fallenBlocks));
    if (fallen <= 0) return;
    if (RAND.next() >= 0.05 + fallen * 0.05) return;
    const next = ANVIL_NEXT.get(placeId);
    if (next === undefined) return;
    if (next === 0) {
      try { world.setBlock(bx, by, bz, 0, 0, 3); } catch { /* optional */ }
      playAt(world, 'anvil_break', bx + 0.5, by + 0.5, bz + 0.5, 0.9, 1);
      particles('block', bx + 0.5, by + 0.5, bz + 0.5, { count: 14, blockId: placeId });
    } else {
      try { world.setBlock(bx, by, bz, next, this.blockMeta, 3); } catch { /* optional */ }
    }
  }

  /** A falling block needs something underneath, or it just keeps going. */
  hasSupport(world, bx, by, bz) {
    if (by <= 0) return true;
    const below = world.getBlock(bx, by - 1, bz);
    return !canFallThrough(below);
  }

  /** Bruises everything the block lands on. Only anvils actually do this. */
  damageLandingEntities() {
    const world = this.world;
    if (!world || !this.hurtEntities) return;
    const fallen = Math.ceil(this.fallenBlocks - 1);
    if (fallen <= 0) return;
    const dmg = Math.min(this.fallHurtMax, Math.floor(fallen * this.fallHurtAmount));
    if (dmg <= 0) return;

    const box = this.aabb(_boxB).expand(0.02, 0.02, 0.02);
    let victims;
    try {
      victims = world.entitiesInAABB(box, (e) => (
        e !== this && !e.removed && typeof e.health === 'number' &&
        e.type !== 'item' && e.type !== 'xp_orb' && e.type !== 'falling_block'
      ));
    } catch { return; }
    if (!victims) return;
    const src = damageSource('falling_anvil', null, this, { bypassCooldown: true });
    for (let i = 0; i < victims.length; i++) {
      try { damageEntity(victims[i], dmg, src); } catch { /* combat is optional */ }
    }
  }

  /**
   * Turns the carried block back into an item on the floor. Vanilla drops the
   * block *item* here rather than rolling the block's loot table, so a gravel
   * pile that cannot land gives back gravel and never flint.
   */
  spill() {
    const world = this.world;
    if (!world) return;
    if (world.gameRules && world.gameRules.doTileDrops === false) return;
    const def = getBlock(this.blockId);
    if (!def || def.air) return;
    const s = mkStack(def.itemName || def.name, 1);
    if (!s) return;
    dropItem(world, this.x, this.y + 0.25, this.z, s,
      (RAND.next() - 0.5) * 0.6, 0.6, (RAND.next() - 0.5) * 0.6);
  }

  /** @override falling blocks are immune to almost everything. */
  hurt(amount, source = null) {
    if (this.removed || !(amount > 0)) return false;
    const type = source && source.type ? source.type : 'generic';
    if (type === 'out_of_world' || type === 'void') { this.remove(); return true; }
    if (source && source.explosion) { this.spill(); this.remove(); return true; }
    return false;
  }

  /** @override */
  fall(_distance) { /* handled by land() */ }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'falling_block';
    o.blockId = this.blockId;
    o.blockMeta = this.blockMeta;
    o.fallTime = this.fallTime;
    o.startY = this.startY;
    o.hurtEntities = this.hurtEntities;
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.blockId !== undefined) {
      this.blockId = obj.blockId & ID_MASK;
      const def = getBlock(this.blockId);
      this.blockName = def ? def.name : 'stone';
      this.hurtEntities = ANVIL_IDS.has(this.blockId);
    }
    if (obj.blockMeta !== undefined) this.blockMeta = obj.blockMeta & 15;
    if (obj.fallTime !== undefined) this.fallTime = obj.fallTime | 0;
    if (obj.startY !== undefined) this.startY = obj.startY;
    if (obj.hurtEntities !== undefined) this.hurtEntities = !!obj.hurtEntities;
    return this;
  }
}

// ===========================================================================
// TNTEntity
// ===========================================================================

/**
 * Primed TNT: an 80-tick fuse, a small upward hop with random horizontal
 * spread, a blink the renderer can read off `flash`, and then a power-4
 * explosion that lights every other stick of TNT it can reach.
 */
export class TNTEntity extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {object|null} igniter whoever lit it, for the damage source
   */
  constructor(world, x, y, z, igniter = null) {
    super(world, x, y, z);
    this.type = 'tnt';
    this.model = 'block';
    this.renderBlock = true;
    this.display = 'TNT';

    this.blockId = ID_TNT > 0 ? ID_TNT : 0;
    this.blockMeta = 0;

    this.width = 0.98;
    this.height = 0.98;
    this.eyeHeight = 0.49;

    this.fuse = TNT_FUSE;
    this.fuseTicks = TNT_FUSE;      // alias combat.js writes to
    this.power = TNT_POWER;
    this.igniter = igniter || null;
    this.owner = igniter || null;
    this.flash = true;
    this.flashIntensity = 0;

    this.health = 5;
    this.maxHealth = 5;
    this.gravity = ITEM_GRAVITY;
    this.drag = ITEM_DRAG;
    this.dragY = ITEM_DRAG;
    this.groundFriction = ITEM_DRAG;
    this.stepHeight = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.fireImmune = true;
    // Deliberately *not* explosionImmune: combat.explode skips those outright,
    // and being caught in a blast is exactly how one charge lights the next.
    // The def hook below turns that hit into a shortened fuse, not damage.
    this._exploded = false;
    this.def = damageHookDef('tnt');

    // Vanilla's launch: straight up a little, with a random horizontal nudge.
    const a = RAND.next() * Math.PI * 2;
    this.vx = -Math.sin(a) * 0.4;
    this.vz = -Math.cos(a) * 0.4;
    this.vy = 4.0;

    playAt(world, 'tnt_prime', x, y, z, 0.9, 1);
  }

  /** @override counts the fuse down, smokes, then goes off. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;

    // `fuseTicks` is the alias combat.js writes; both always move together.
    this.fuse--;
    this.fuseTicks = this.fuse;

    // Blink every other tick, faster and brighter as the fuse runs out.
    this.flash = ((this.fuse >> 1) & 1) === 0;
    this.flashIntensity = clamp(1 - this.fuse / TNT_FUSE, 0, 1);

    if (this.fuse <= 0) { this.explodeNow(); return; }

    particles('smoke', this.x, this.y + this.height + 0.1, this.z, { count: 1, vy: 0.6, size: 0.4 });
  }

  /** Blows up: a power-4 blast plus a chain reaction on nearby primed TNT. */
  explodeNow() {
    if (this._exploded) return;
    this._exploded = true;
    const world = this.world;
    const x = this.x, y = this.y + this.height * 0.5, z = this.z;
    this.remove();
    if (!world) return;

    this.chainIgnite(world, x, y, z);

    const griefing = !world.gameRules || world.gameRules.mobGriefing !== false;
    try {
      explode(world, x, y, z, this.power, {
        fire: false,
        breakBlocks: griefing,
        source: this.igniter || this,
        entity: this.igniter || this,
      });
    } catch (e) {
      console.error('[itementity] TNT explosion failed', e);
    }
  }

  /** Shortens the fuse on every other primed charge inside the blast radius. */
  chainIgnite(world, x, y, z) {
    if (!world || typeof world.entitiesNear !== 'function') return;
    let list;
    try {
      list = world.entitiesNear(x, y, z, this.power * 2, (e) => e !== this && !e.removed && e.type === 'tnt');
    } catch { return; }
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const jitter = 4 + RAND.int(18);
      if (t.fuse === undefined || t.fuse > jitter) {
        t.fuse = jitter;
        t.fuseTicks = jitter;
      }
    }
  }

  /** @override primed TNT is not damaged, it is only ever detonated. */
  hurt(amount, source = null) {
    if (this.removed || !(amount > 0)) return false;
    const type = source && source.type ? source.type : 'generic';
    if (type === 'out_of_world' || type === 'void') { this.remove(); return true; }
    // Being caught in someone else's blast lights this one early.
    if (source && (source.explosion || type === 'explosion')) {
      if (this.fuse > 10) { this.fuse = 2 + RAND.int(8); this.fuseTicks = this.fuse; }
      return true;
    }
    return false;
  }

  /** @override */
  fall(_distance) { /* TNT lands with a thud, not a bruise */ }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'tnt';
    o.fuse = this.fuse;
    o.power = this.power;
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.fuse !== undefined) { this.fuse = obj.fuse | 0; this.fuseTicks = this.fuse; }
    if (obj.power !== undefined) this.power = obj.power;
    return this;
  }
}

// ===========================================================================
// LeashKnot
// ===========================================================================

/**
 * The little knot that appears when a lead is tied to a fence. It has no
 * physics of its own; it only exists so leashed mobs have something to orbit.
 */
export class LeashKnot extends Entity {
  /**
   * @param {object} world
   * @param {number} bx @param {number} by @param {number} bz fence block coords
   */
  constructor(world, bx, by, bz) {
    super(world, Math.floor(bx) + 0.5, Math.floor(by) + 0.375, Math.floor(bz) + 0.5);
    this.type = 'leash_knot';
    this.model = 'leash_knot';
    this.display = 'Lead Knot';

    this.blockX = Math.floor(bx);
    this.blockY = Math.floor(by);
    this.blockZ = Math.floor(bz);

    this.width = 0.375;
    this.height = 0.5;
    this.eyeHeight = 0.25;

    this.health = 10;
    this.maxHealth = 10;
    this.noGravity = true;
    this.gravity = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.fireImmune = true;
    this.persistent = true;
    this.def = damageHookDef('leash_knot');
  }

  /** @override drops the knot when the fence goes away or nothing is tied. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;
    if ((this.age % 20) !== 0) return;

    const world = this.world;
    if (!world) return;
    const id = world.getBlock(this.blockX, this.blockY, this.blockZ);
    if (id === 0 || (FENCE_IDS.size > 0 && !FENCE_IDS.has(id))) { this.snap(); return; }
    if (!this.hasLeashedEntities()) this.snap();
  }

  /** True while at least one entity is still tied here. */
  hasLeashedEntities() {
    const world = this.world;
    if (!world || typeof world.entitiesNear !== 'function') return true;   // be forgiving
    try {
      const list = world.entitiesNear(this.x, this.y, this.z, 12, (e) => e !== this && !e.removed && e.leashedTo === this);
      return !!(list && list.length);
    } catch { return true; }
  }

  /** Frees everything tied here and removes the knot. */
  snap(dropLead = true) {
    const world = this.world;
    if (world && typeof world.entitiesNear === 'function') {
      try {
        const list = world.entitiesNear(this.x, this.y, this.z, 12, (e) => e && e.leashedTo === this);
        if (list) for (let i = 0; i < list.length; i++) list[i].leashedTo = null;
      } catch { /* optional */ }
    }
    if (dropLead && world) dropItem(world, this.x, this.y, this.z, mkStack('lead', 1), 0, 1.2, 0);
    this.remove();
  }

  /** Ties an entity to this knot. */
  attach(entity) {
    if (!entity) return false;
    entity.leashedTo = this;
    return true;
  }

  /** @override a punch cuts the lead. */
  hurt(amount, source = null) {
    if (this.removed || !(amount > 0)) return false;
    const creative = source && source.entity && source.entity.gameMode === 'creative';
    this.snap(!creative);
    return true;
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'leash_knot';
    o.blockX = this.blockX; o.blockY = this.blockY; o.blockZ = this.blockZ;
    return o;
  }
}

/** Finds the knot tied to a fence, or ties a new one. @returns {LeashKnot} */
export function leashKnotAt(world, x, y, z) {
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  if (!world) return null;
  if (typeof world.entitiesNear === 'function') {
    try {
      const found = world.entitiesNear(bx + 0.5, by + 0.5, bz + 0.5, 1.2,
        (e) => e && !e.removed && e.type === 'leash_knot' &&
          e.blockX === bx && e.blockY === by && e.blockZ === bz);
      if (found && found.length) return found[0];
    } catch { /* fall through and make a new one */ }
  }
  const knot = new LeashKnot(world, bx, by, bz);
  try { world.addEntity(knot); } catch { /* optional */ }
  return knot;
}

// ===========================================================================
// ItemFrame
// ===========================================================================

/**
 * A frame hanging on a wall with (optionally) an item inside it.
 *
 * `facing` is a FACE_* index pointing *out* of the wall; the block it is
 * mounted on sits one step the other way.
 */
export class ItemFrame extends Entity {
  /**
   * @param {object} world
   * @param {number} bx @param {number} by @param {number} bz the air block it hangs in
   * @param {number} facing FACE_* index the frame looks along
   * @param {{glow?:boolean, stack?:object}} [opts]
   */
  constructor(world, bx, by, bz, facing = FACE_NORTH, opts = {}) {
    const fx = Math.floor(bx), fy = Math.floor(by), fz = Math.floor(bz);
    const d = FACE_DIRS[facing] || FACE_DIRS[FACE_NORTH];
    super(world, fx + 0.5 - d[0] * 0.4375, fy + 0.5 - d[1] * 0.4375 - 0.25, fz + 0.5 - d[2] * 0.4375);
    this.type = 'item_frame';
    this.model = 'item_frame';
    this.display = opts.glow ? 'Glow Item Frame' : 'Item Frame';

    this.blockX = fx; this.blockY = fy; this.blockZ = fz;
    this.facing = facing;
    this.glow = !!opts.glow;
    /** @type {object|null} */
    this.stack = isEmpty(opts.stack) ? null : copyStack(opts.stack);
    /** 0..7, one eighth of a turn each. */
    this.rotation = 0;

    this.width = 0.5;
    this.height = 0.5;
    this.eyeHeight = 0.25;

    this.health = 1;
    this.maxHealth = 1;
    this.noGravity = true;
    this.gravity = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.persistent = true;
    this.yaw = frameYaw(facing);
    this.def = damageHookDef('item_frame');
  }

  /** Coordinates of the block the frame is nailed to. */
  supportPos() {
    const d = FACE_DIRS[FACE_OPPOSITE[this.facing]] || [0, 0, 1];
    return { x: this.blockX + d[0], y: this.blockY + d[1], z: this.blockZ + d[2] };
  }

  /** @override falls off when its wall disappears. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;
    if ((this.age % 40) !== 0) return;
    const world = this.world;
    if (!world) return;
    const p = this.supportPos();
    const id = world.getBlock(p.x, p.y, p.z);
    const def = getBlock(id);
    if (id === 0 || !def || !def.solid) this.breakFrame(true);
  }

  /**
   * Right-click behaviour: an empty frame takes the held item, a full one
   * rotates its contents.
   * @returns {boolean} true when the click was consumed
   */
  interact(player, held) {
    if (isEmpty(this.stack)) {
      if (isEmpty(held)) return false;
      this.stack = copyStack(held);
      this.stack.count = 1;
      this.rotation = 0;
      playAt(this.world, 'item_pickup', this.x, this.y, this.z, 0.5, 1.2);
      if (player && player.gameMode !== 'creative' && held.count !== undefined) held.count -= 1;
      return true;
    }
    this.rotation = (this.rotation + 1) & 7;
    playAt(this.world, 'click', this.x, this.y, this.z, 0.4, 1.1);
    return true;
  }

  /** Pops the contents out, and optionally the frame itself. */
  breakFrame(dropSelf = true) {
    if (this.removed) return;
    const world = this.world;
    if (world) {
      if (!isEmpty(this.stack)) dropItem(world, this.x, this.y, this.z, this.stack, 0, 1.2, 0);
      if (dropSelf) {
        dropItem(world, this.x, this.y, this.z,
          mkStack(this.glow ? 'glow_item_frame' : 'item_frame', 1), 0, 1.2, 0);
      }
      playAt(world, 'dig_wood', this.x, this.y, this.z, 0.6, 1);
    }
    this.stack = null;
    this.remove();
  }

  /** @override one hit empties it, a second one takes the frame down. */
  hurt(amount, source = null) {
    if (this.removed || !(amount > 0)) return false;
    const creative = !!(source && source.entity && source.entity.gameMode === 'creative');
    if (!isEmpty(this.stack) && !creative) {
      const world = this.world;
      if (world) dropItem(world, this.x, this.y, this.z, this.stack, 0, 1.2, 0);
      this.stack = null;
      return true;
    }
    this.breakFrame(!creative);
    return true;
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'item_frame';
    o.blockX = this.blockX; o.blockY = this.blockY; o.blockZ = this.blockZ;
    o.facing = this.facing;
    o.glow = this.glow;
    o.rotation = this.rotation;
    o.stack = isEmpty(this.stack) ? null : copyStack(this.stack);
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.blockX !== undefined) this.blockX = obj.blockX | 0;
    if (obj.blockY !== undefined) this.blockY = obj.blockY | 0;
    if (obj.blockZ !== undefined) this.blockZ = obj.blockZ | 0;
    if (obj.facing !== undefined) { this.facing = obj.facing | 0; this.yaw = frameYaw(this.facing); }
    if (obj.glow !== undefined) this.glow = !!obj.glow;
    if (obj.rotation !== undefined) this.rotation = obj.rotation & 7;
    if (obj.stack !== undefined) this.stack = isEmpty(obj.stack) ? null : copyStack(obj.stack);
    return this;
  }
}

/** Yaw for a wall-mounted entity looking along a FACE_* direction. */
function frameYaw(face) {
  switch (face) {
    case FACE_SOUTH: return 0;
    case FACE_WEST: return Math.PI / 2;
    case FACE_NORTH: return Math.PI;
    case FACE_EAST: return -Math.PI / 2;
    default: return 0;
  }
}

// ===========================================================================
// Painting
// ===========================================================================

/** Every vanilla painting motive, in blocks. */
export const PAINTING_MOTIVES = {
  kebab: { w: 1, h: 1 }, aztec: { w: 1, h: 1 }, alban: { w: 1, h: 1 }, aztec2: { w: 1, h: 1 },
  bomb: { w: 1, h: 1 }, plant: { w: 1, h: 1 }, wasteland: { w: 1, h: 1 },
  pool: { w: 2, h: 1 }, courbet: { w: 2, h: 1 }, sea: { w: 2, h: 1 },
  sunset: { w: 2, h: 1 }, creebet: { w: 2, h: 1 },
  wanderer: { w: 1, h: 2 }, graham: { w: 1, h: 2 },
  match: { w: 2, h: 2 }, bust: { w: 2, h: 2 }, stage: { w: 2, h: 2 }, void: { w: 2, h: 2 },
  skull_and_roses: { w: 2, h: 2 }, wither: { w: 2, h: 2 },
  fighters: { w: 4, h: 2 },
  pointer: { w: 4, h: 4 }, pigscene: { w: 4, h: 4 }, burning_skull: { w: 4, h: 4 },
  skeleton: { w: 4, h: 3 }, donkey_kong: { w: 4, h: 3 },
  earth: { w: 2, h: 2 }, wind: { w: 2, h: 2 }, water: { w: 2, h: 2 }, fire: { w: 2, h: 2 },
};

const PAINTING_NAMES = Object.keys(PAINTING_MOTIVES);

/** A picture hanging on a wall. Size comes from the motive. */
export class Painting extends Entity {
  /**
   * @param {object} world
   * @param {number} bx @param {number} by @param {number} bz anchor block
   * @param {number} facing FACE_* index the painting looks along
   * @param {string} [motive] motive name; a random one when omitted
   */
  constructor(world, bx, by, bz, facing = FACE_NORTH, motive = null) {
    const fx = Math.floor(bx), fy = Math.floor(by), fz = Math.floor(bz);
    const d = FACE_DIRS[facing] || FACE_DIRS[FACE_NORTH];
    super(world, fx + 0.5 - d[0] * 0.46, fy + 0.5 - d[1] * 0.46, fz + 0.5 - d[2] * 0.46);
    this.type = 'painting';
    this.model = 'painting';

    const key = motive && PAINTING_MOTIVES[motive] ? motive : PAINTING_NAMES[RAND.int(PAINTING_NAMES.length)];
    const m = PAINTING_MOTIVES[key];
    this.motive = key;
    this.display = prettyName(key);
    this.artWidth = m.w;
    this.artHeight = m.h;

    this.blockX = fx; this.blockY = fy; this.blockZ = fz;
    this.facing = facing;
    this.yaw = frameYaw(facing);

    // The hitbox is a thin slab spanning the whole canvas.
    this.width = Math.max(0.5, (facing === FACE_NORTH || facing === FACE_SOUTH) ? m.w : 0.5);
    this.height = m.h;
    this.eyeHeight = m.h * 0.5;

    this.health = 1;
    this.maxHealth = 1;
    this.noGravity = true;
    this.gravity = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.persistent = true;
    this.def = damageHookDef('painting');
  }

  /** @override */
  aabb(out) {
    const b = out || new AABB();
    const horizontal = (this.facing === FACE_NORTH || this.facing === FACE_SOUTH);
    const halfW = this.artWidth * 0.5;
    const cx = this.x, cz = this.z;
    const y0 = this.y - this.artHeight * 0.5;
    if (horizontal) return b.set(cx - halfW, y0, cz - 0.06, cx + halfW, y0 + this.artHeight, cz + 0.06);
    return b.set(cx - 0.06, y0, cz - halfW, cx + 0.06, y0 + this.artHeight, cz + halfW);
  }

  /** @override falls off when the wall behind it is gone. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;
    if ((this.age % 60) !== 0) return;
    const world = this.world;
    if (!world) return;
    const d = FACE_DIRS[FACE_OPPOSITE[this.facing]] || [0, 0, 1];
    const id = world.getBlock(this.blockX + d[0], this.blockY + d[1], this.blockZ + d[2]);
    const def = getBlock(id);
    if (id === 0 || !def || !def.solid) this.breakPainting(true);
  }

  /** Drops the painting item and removes the entity. */
  breakPainting(dropSelf = true) {
    if (this.removed) return;
    const world = this.world;
    if (world) {
      if (dropSelf) dropItem(world, this.x, this.y, this.z, mkStack('painting', 1), 0, 1.2, 0);
      playAt(world, 'dig_wood', this.x, this.y, this.z, 0.6, 1);
    }
    this.remove();
  }

  /** @override */
  hurt(amount, source = null) {
    if (this.removed || !(amount > 0)) return false;
    const creative = !!(source && source.entity && source.entity.gameMode === 'creative');
    this.breakPainting(!creative);
    return true;
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'painting';
    o.motive = this.motive;
    o.facing = this.facing;
    o.blockX = this.blockX; o.blockY = this.blockY; o.blockZ = this.blockZ;
    return o;
  }
}

// ===========================================================================
// ArmorStand
// ===========================================================================

/**
 * A poseable mannequin. It is a LivingEntity so armour, enchantments and the
 * damage pipeline all work on it unchanged, but it has no AI, never moves on
 * its own, and shatters into its parts when it is broken.
 */
export class ArmorStand extends LivingEntity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {{small?:boolean, showArms?:boolean, noBasePlate?:boolean, marker?:boolean}} [opts]
   */
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'armor_stand';
    this.model = 'armor_stand';
    this.skin = 'armor_stand';
    this.display = 'Armor Stand';

    this.small = !!opts.small;
    this.showArms = opts.showArms !== undefined ? !!opts.showArms : false;
    this.noBasePlate = !!opts.noBasePlate;
    this.marker = !!opts.marker;

    this.resize();

    this.health = 20;
    this.maxHealth = 20;
    this.xpReward = 0;
    this.armor = 0;
    this.stepHeight = 0;
    this.pushable = false;
    // A stand stays exactly where it was put: punching it must not slide it
    // across the floor the way knockback would move a mob.
    this.knockbackResist = 1;
    this.canPickUpLoot = false;
    this.persistent = true;
    this.noAI = true;
    this.living = true;

    /** Per-part Euler rotations the model applies verbatim. */
    this.pose = {
      head: [0, 0, 0],
      body: [0, 0, 0],
      right_arm: [-0.17, 0, -0.17],
      left_arm: [-0.17, 0, 0.17],
      right_leg: [-0.02, 0, -0.02],
      left_leg: [0.02, 0, 0.02],
    };
    /** Ticks left of the "just punched" wobble. */
    this.wobbleTicks = 0;

    // A definition, so `combat.damageEntity` finds the punch hook *and*
    // `loot.mobDrops` finds a drop table. It intentionally mirrors the
    // `armor_stand` entry in mobs.js rather than importing it, which would put
    // the whole mob registry in this module's dependency chain.
    this.def = {
      name: 'armor_stand',
      category: 'passive',
      xp: 0,
      notAMob: true,
      drops: [{ item: 'armor_stand', min: 1, max: 1 }],
      onHurt: (self, amount, src) => (self.handlePunch(amount, src) ? false : undefined),
    };
  }

  /** Recomputes the hitbox after `small` changes (including on load). */
  resize() {
    this.width = this.small ? 0.25 : 0.5;
    this.height = this.small ? 0.9875 : 1.975;
    this.eyeHeight = this.height * 0.9;
    return this;
  }

  /** @override no AI, no limb swing, just a wobble timer. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;
    if (this.wobbleTicks > 0) this.wobbleTicks--;
    this.vx = 0; this.vz = 0;
    this.limbSwingAmount = 0;
  }

  /** Swaps an armour piece with whatever the player is holding. */
  interact(player, held, slot) {
    const idx = typeof slot === 'number' ? slot : armorSlotFor(held);
    if (idx < 0) return false;
    const current = this.getEquipment(idx);
    let put = null;
    if (!isEmpty(held)) { put = copyStack(held); put.count = 1; }
    this.setEquipment(idx, put);
    if (put && player && player.gameMode !== 'creative' && held.count !== undefined) held.count -= 1;
    if (!isEmpty(current) && player && typeof player.giveItem === 'function') {
      const left = player.giveItem(current);
      if (!isEmpty(left) && this.world) dropItem(this.world, this.x, this.y + 1, this.z, left, 0, 1, 0);
    }
    playAt(this.world, 'armor_equip', this.x, this.y, this.z, 0.6, 1);
    return true;
  }

  /**
   * The one place a hit is interpreted, whether it arrived through
   * `entity.hurt()` or through `combat.damageEntity`'s def hook.
   * @returns {boolean} true when the hit is fully dealt with and no damage
   *          should be applied on top
   */
  handlePunch(amount, source) {
    if (this.removed || this.dead) return true;
    this.wobbleTicks = 10;
    const attacker = source && source.entity;
    // Creative players shatter a stand outright; the gear still falls out, but
    // the stand itself does not come back, exactly like vanilla.
    if (attacker && attacker.gameMode === 'creative') {
      this.dropEquipment();
      playAt(this.world, 'dig_wood', this.x, this.y, this.z, 0.8, 0.9);
      this.remove();
      return true;
    }
    playAt(this.world, 'hit_generic', this.x, this.y, this.z, 0.6, 1);
    return false;
  }

  /** @override records the wobble and lets creative players one-shot it. */
  hurt(amount, source = null) {
    if (this.handlePunch(amount, source)) return false;
    return super.hurt(amount, source);
  }

  /** @override scatters everything it was wearing. */
  onDeath(_source) {
    this.dropEquipment();
    playAt(this.world, 'dig_wood', this.x, this.y, this.z, 0.8, 0.9);
  }

  /** Drops every worn piece. The stand item itself comes from the loot table. */
  dropEquipment() {
    const world = this.world;
    if (!world) return;
    for (let i = 0; i < this.equipment.length; i++) {
      const s = this.equipment[i];
      if (isEmpty(s)) continue;
      this.equipment[i] = null;
      dropItem(world, this.x, this.y + this.height * 0.5, this.z, s,
        (RAND.next() - 0.5) * 1.5, 1.5, (RAND.next() - 0.5) * 1.5);
    }
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'armor_stand';
    o.small = this.small;
    o.showArms = this.showArms;
    o.noBasePlate = this.noBasePlate;
    o.marker = this.marker;
    o.pose = this.pose;
    o.equipment = this.equipment.map((s) => (isEmpty(s) ? null : copyStack(s)));
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.small !== undefined) { this.small = !!obj.small; this.resize(); }
    if (obj.showArms !== undefined) this.showArms = !!obj.showArms;
    if (obj.noBasePlate !== undefined) this.noBasePlate = !!obj.noBasePlate;
    if (obj.marker !== undefined) this.marker = !!obj.marker;
    if (obj.pose) this.pose = obj.pose;
    if (Array.isArray(obj.equipment)) {
      for (let i = 0; i < Math.min(6, obj.equipment.length); i++) {
        this.equipment[i] = isEmpty(obj.equipment[i]) ? null : copyStack(obj.equipment[i]);
      }
    }
    return this;
  }
}

/** Which equipment slot a stack belongs in, or -1 when it is not wearable. */
function armorSlotFor(s) {
  if (isEmpty(s)) return EQUIP.MAINHAND;
  let def = null;
  try { def = getItem(s.item); } catch { def = null; }
  const slot = def && def.armor ? def.armor.slot : null;
  if (slot === 'head') return EQUIP.HEAD;
  if (slot === 'chest') return EQUIP.CHEST;
  if (slot === 'legs') return EQUIP.LEGS;
  if (slot === 'feet') return EQUIP.FEET;
  return EQUIP.MAINHAND;
}

// ===========================================================================
// EndCrystal
// ===========================================================================

/**
 * An end crystal: floats above bedrock, feeds a healing beam to the ender
 * dragon, and detonates violently the instant anything touches it.
 */
export class EndCrystal extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {{showBase?:boolean, beamTarget?:boolean, power?:number}} [opts]
   */
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = 'end_crystal';
    this.model = 'end_crystal';
    this.display = 'End Crystal';

    this.width = 2;
    this.height = 2;
    this.eyeHeight = 1;

    this.showBase = opts.showBase !== false;
    this.power = opts.power !== undefined ? opts.power : END_CRYSTAL_POWER;
    /** The dragon this crystal is currently feeding, or null. */
    this.beamTarget = null;
    /** Set by worldgen: this crystal sits on a pillar and looks for a dragon. */
    this.pillarCrystal = !!opts.beamTarget;

    this.health = 1;
    this.maxHealth = 1;
    this.noGravity = true;
    this.gravity = 0;
    this.pushable = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.fireImmune = true;
    this.fireResistant = true;
    this.persistent = true;

    this.hoverStart = RAND.next() * Math.PI * 2;
    this.bobOffset = 0;
    this.spinAngle = this.hoverStart;
    this._exploding = false;
    this.def = damageHookDef('end_crystal');
  }

  /** @override spins, bobs, and keeps the healing beam pointed somewhere. */
  update(dt) {
    if (this.removed) return;
    super.update(dt);
    if (dt > 0) {
      this.spinAngle += dt * 1.5;
      this.bobOffset = Math.sin(this.hoverStart + this.spinAngle * 0.8) * 0.2;
    }
  }

  /** @override */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;

    // Heal the dragon on a slow cadence; mobs.js does its own top-up, so this
    // stays gentle rather than making the fight unwinnable.
    if ((this.age % 40) === 0) {
      const dragon = this.findDragon();
      this.beamTarget = dragon;
      if (dragon && dragon.health < dragon.maxHealth && typeof dragon.heal === 'function') {
        try { dragon.heal(1); } catch { /* optional */ }
      }
    }
    if ((this.age & 7) === 0) {
      particles('end_rod', this.x, this.y + 1 + this.bobOffset, this.z, { count: 1, size: 0.4 });
    }
  }

  /** Nearest ender dragon within 96 blocks, or null. */
  findDragon() {
    const world = this.world;
    if (!world || typeof world.nearestEntity !== 'function') return null;
    try {
      return world.nearestEntity(this.x, this.y, this.z, 96,
        (e) => e && !e.removed && !e.dead && (e.type === 'ender_dragon' || e.mobName === 'ender_dragon'));
    } catch { return null; }
  }

  /** @override any hit at all sets it off. */
  hurt(amount, source = null) {
    if (this.removed || this._exploding) return false;
    if (!(amount > 0)) return false;
    const type = source && source.type ? source.type : 'generic';
    if (type === 'drown' || type === 'in_wall') return false;
    this.detonate(source && source.entity);
    return true;
  }

  /** Removes the crystal and touches off a power-6 blast in its place. */
  detonate(igniter = null) {
    if (this._exploding) return;
    this._exploding = true;
    const world = this.world;
    const x = this.x, y = this.y + 1, z = this.z;
    this.beamTarget = null;
    this.remove();
    if (!world) return;
    try {
      explode(world, x, y, z, this.power, {
        fire: false,
        breakBlocks: !world.gameRules || world.gameRules.mobGriefing !== false,
        source: igniter || this,
        entity: igniter || this,
      });
    } catch (e) {
      console.error('[itementity] end crystal explosion failed', e);
    }
  }

  /** @override */
  kill(_source) { this.detonate(null); }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = 'end_crystal';
    o.showBase = this.showBase;
    o.pillarCrystal = this.pillarCrystal;
    o.power = this.power;
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.showBase !== undefined) this.showBase = !!obj.showBase;
    if (obj.pillarCrystal !== undefined) this.pillarCrystal = !!obj.pillarCrystal;
    if (obj.power !== undefined) this.power = obj.power;
    return this;
  }
}

// ===========================================================================
// Spawn helpers - the public surface every other module actually calls
// ===========================================================================

/**
 * Drops a stack in the world as a loose item.
 *
 * A stack bigger than its own limit is split across several entities, so
 * `/give diamond 200` scatters four drops instead of one impossible one.
 * Velocity arguments are optional; leaving them out gives a random pop.
 *
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z
 * @param {object} stack the item stack (copied)
 * @param {number} [vx] @param {number} [vy] @param {number} [vz] blocks/second
 * @returns {ItemEntity|null} the (last) entity spawned
 */
export function dropItem(world, x, y, z, stack, vx, vy, vz) {
  if (!world || isEmpty(stack)) return null;

  const template = copyStack(stack);
  const max = Math.max(1, maxStackSize(template));
  let remaining = template.count | 0;
  let last = null;
  let guard = 64;

  while (remaining > 0 && guard-- > 0) {
    const take = Math.min(max, remaining);
    remaining -= take;
    const piece = copyStack(template);
    piece.count = take;

    const e = new ItemEntity(world, x, y, z, piece);
    e.vx = vx !== undefined && vx !== null ? vx : (RAND.next() - 0.5) * 2;
    e.vy = vy !== undefined && vy !== null ? vy : 1.2 + RAND.next() * 0.8;
    e.vz = vz !== undefined && vz !== null ? vz : (RAND.next() - 0.5) * 2;
    // Split stacks get a small extra scatter so they do not stack right back up.
    if (remaining > 0 || guard < 63) {
      e.vx += (RAND.next() - 0.5) * 0.8;
      e.vz += (RAND.next() - 0.5) * 0.8;
    }
    try { world.addEntity(e); } catch { return last; }
    last = e;
  }
  return last;
}

/**
 * Drops a whole list of stacks with a natural scatter. Used by block breaking,
 * container spills and mob loot.
 * @returns {ItemEntity[]} the entities that were created
 */
export function dropStacks(world, x, y, z, stacks) {
  const out = [];
  if (!world || !stacks) return out;
  const list = Array.isArray(stacks) ? stacks : [stacks];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (isEmpty(s)) continue;
    const a = RAND.next() * Math.PI * 2;
    const speed = 0.4 + RAND.next() * 1.0;
    const e = dropItem(world, x, y, z, s,
      Math.cos(a) * speed, 1.4 + RAND.next() * 0.7, Math.sin(a) * speed);
    if (e) out.push(e);
  }
  return out;
}

/**
 * Scatters `amount` experience points as the fewest orbs that add up to it.
 * @returns {XPOrb[]} the orbs that were created
 */
export function dropXP(world, x, y, z, amount) {
  const out = [];
  let n = Math.floor(amount || 0);
  if (!world || n <= 0) return out;
  let guard = 64;
  while (n > 0 && guard-- > 0) {
    const v = Math.min(n, orbValue(n));
    n -= v;
    const orb = new XPOrb(world, x, y, z, v);
    orb.vx = (RAND.next() - 0.5) * 2;
    orb.vy = 1.0 + RAND.next() * 1.6;
    orb.vz = (RAND.next() - 0.5) * 2;
    try { world.addEntity(orb); } catch { break; }
    out.push(orb);
  }
  return out;
}

/**
 * Turns the block at (x, y, z) into a FallingBlock and clears the block.
 *
 * Refuses when the block is not a gravity block, or when there is something
 * solid right underneath it, unless `force` is set.
 *
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z block coordinates
 * @param {boolean} [force] skip the gravity/support checks
 * @returns {FallingBlock|null}
 */
export function spawnFallingBlock(world, x, y, z, force = false) {
  if (!world) return null;
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  if (by <= 0 || by >= WORLD_HEIGHT) return null;

  const raw = world.getRaw(bx, by, bz);
  const id = raw & ID_MASK;
  if (id === 0) return null;
  const def = getBlock(id);
  if (!def || def.air) return null;
  if (!force && !def.gravity) return null;
  if (!force && !canFallThrough(world.getBlock(bx, by - 1, bz))) return null;

  const meta = (raw >>> 12) & 15;
  try { world.setBlock(bx, by, bz, 0, 0, 3); } catch { return null; }

  const e = new FallingBlock(world, bx + 0.5, by, bz + 0.5, id, meta);
  try { world.addEntity(e); } catch { return null; }
  return e;
}

/**
 * Lights the TNT block at (x, y, z): clears it and spawns primed TNT.
 * combat.js calls this so an explosion can chain through TNT.
 *
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z
 * @param {number} [fuse] fuse in ticks
 * @param {object|null} [igniter] whoever is to blame
 * @returns {TNTEntity|null}
 */
export function primeTNT(world, x, y, z, fuse = TNT_FUSE, igniter = null) {
  if (!world) return null;
  const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
  if (world.getBlock(bx, by, bz) === ID_TNT && ID_TNT > 0) {
    try { world.setBlock(bx, by, bz, 0, 0, 3); } catch { /* keep going */ }
  }
  const t = new TNTEntity(world, bx + 0.5, by, bz + 0.5, igniter);
  const f = Math.max(1, fuse | 0);
  t.fuse = f;
  t.fuseTicks = f;
  try { world.addEntity(t); } catch { return null; }
  return t;
}

/**
 * Places an end crystal on top of a block.
 * @returns {EndCrystal|null}
 */
export function spawnEndCrystal(world, x, y, z, opts = {}) {
  if (!world) return null;
  const e = new EndCrystal(world, x, y, z, opts);
  try { world.addEntity(e); } catch { return null; }
  return e;
}

/**
 * Hangs an item frame on a wall.
 * @returns {ItemFrame|null}
 */
export function spawnItemFrame(world, x, y, z, facing = FACE_NORTH, opts = {}) {
  if (!world) return null;
  const e = new ItemFrame(world, x, y, z, facing, opts);
  try { world.addEntity(e); } catch { return null; }
  return e;
}

/**
 * Hangs a painting on a wall.
 * @returns {Painting|null}
 */
export function spawnPainting(world, x, y, z, facing = FACE_NORTH, motive = null) {
  if (!world) return null;
  const e = new Painting(world, x, y, z, facing, motive);
  try { world.addEntity(e); } catch { return null; }
  return e;
}

/**
 * Stands an armour stand on the ground.
 * @returns {ArmorStand|null}
 */
export function spawnArmorStand(world, x, y, z, opts = {}) {
  if (!world) return null;
  const e = new ArmorStand(world, x, y, z, opts);
  try { world.addEntity(e); } catch { return null; }
  return e;
}

/**
 * Every loose item lying within `radius` of a point. Handy for hoppers,
 * allays, foxes and the /clear command.
 * @returns {ItemEntity[]}
 */
export function itemsNear(world, x, y, z, radius) {
  if (!world || typeof world.entitiesNear !== 'function') return [];
  try {
    return world.entitiesNear(x, y, z, radius, (e) => e && !e.removed && e.type === 'item');
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Save/load registration
// ---------------------------------------------------------------------------
registerEntityType('item', ItemEntity);
registerEntityType('xp_orb', XPOrb);
registerEntityType('falling_block', FallingBlock);
registerEntityType('tnt', TNTEntity);
registerEntityType('leash_knot', LeashKnot);
registerEntityType('item_frame', ItemFrame);
registerEntityType('painting', Painting);
registerEntityType('armor_stand', ArmorStand);
// 'end_crystal' is deliberately left to projectiles.js, which owns the
// spawn path items.js calls; registering it here too would make which class a
// save rebuilds depend on module load order.

export default {
  ItemEntity, XPOrb, FallingBlock, TNTEntity,
  LeashKnot, ItemFrame, Painting, ArmorStand, EndCrystal,
  dropItem, dropStacks, dropXP, spawnFallingBlock, primeTNT,
  spawnEndCrystal, spawnItemFrame, spawnPainting, spawnArmorStand, itemsNear,
};
