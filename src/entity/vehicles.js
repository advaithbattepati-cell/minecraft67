// ============================================================================
// vehicles.js - Boats, minecarts, and the riding rules everything else reuses.
//
// Three things live here:
//
//   1. `mount` / `dismount` / `Rideable` - the generic "entity A is sitting on
//      entity B" contract. A rider carries `riding` (and the `vehicle` alias
//      render/models.js reads); a vehicle carries `passengers`. Nothing else
//      in the codebase needs to know how seats are laid out.
//   2. `Boat` - buoyancy against the real water surface, paddle steering where
//      A/D turn instead of strafing, ice sliding, two seats, chest boats.
//   3. `Minecart` - rail following for all ten rail shapes, powered/detector/
//      activator behaviour, momentum, derailing, cart-to-cart collisions, and
//      the five cart types.
//
// Units follow entity.js: positions in blocks, velocities in blocks per
// SECOND, durations in ticks. `update(dt)` is the per-frame half and owns the
// physics; `tick()` is the 20 Hz half and owns discrete logic.
// ============================================================================
import {
  GRAVITY, WORLD_HEIGHT, TICKS_PER_SECOND, ID_MASK,
} from '../core/constants.js';
import { AABB, clamp, angleDiff, prettyName } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { Game } from '../core/game.js';
import { getBlock, blockByName } from '../world/blocks.js';
import { Entity, registerEntityType } from './entity.js';
import { Inventory, stack as mkStack, isEmpty, copyStack } from '../item/inventory.js';
import { itemExists } from '../item/items.js';
import { fuelTicks } from '../item/smelting.js';
import { damageSource, explode } from './combat.js';

// ---------------------------------------------------------------------------
// Lazily resolved siblings.
//
// itementity.js extends Entity and loot.js reaches back into items.js, so a
// static import of either would close a cycle; redstone.js may not even exist
// yet while the project is being assembled. All three are optional - a missing
// module degrades one feature, it never blanks the screen.
// ---------------------------------------------------------------------------
let _itementity = null;
let _redstone = null;
let _loot = null;
let _depsStarted = false;

function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, assign) => {
    try { import(path).then(assign).catch(() => { /* optional */ }); } catch { /* no dynamic import */ }
  };
  grab('./itementity.js', (m) => { _itementity = m; });
  grab('../world/redstone.js', (m) => { _redstone = m; });
  grab('../item/loot.js', (m) => { _loot = m; });
}
loadDeps();

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** How far above a rail block's floor the rail surface sits. */
const RAIL_H = 0.0625;

const BOAT_WIDTH = 1.375;
const BOAT_HEIGHT = 0.5625;
/** Fraction of the hull that rides below the waterline. */
const BOAT_DRAFT = 0.28;
/** Spring constant pulling the hull towards the waterline (blocks/s^2 per block). */
const BOAT_BUOYANCY = 42;
/** Per-tick vertical damping while floating, so the boat settles instead of bobbing forever. */
const BOAT_WATER_DAMP = 0.62;
const BOAT_GRAVITY = 16;
/** Forward paddle acceleration. Terminal speed is roughly accel / (20 * (1 - friction)). */
const BOAT_ACCEL = 16;
const BOAT_BACK_ACCEL = 5;
const BOAT_TURN_ACCEL = 5.5;
const BOAT_TURN_MAX = 1.9;
const BOAT_FRICTION_WATER = 0.90;
const BOAT_FRICTION_LAND = 0.50;
const BOAT_FRICTION_AIR = 0.96;
/** Hard cap so blue ice cannot fling a boat through the chunk loader. */
const BOAT_MAX_SPEED = 42;
/** Accumulated damage (in tenths, vanilla style) that destroys a vehicle. */
const VEHICLE_BREAK_DAMAGE = 40;

const CART_WIDTH = 0.98;
const CART_HEIGHT = 0.7;
/** Vanilla tops a minecart out at 0.4 blocks/tick. */
const CART_MAX_SPEED = 8;
/** Rolling resistance per tick while on a rail. */
const CART_DRAG = 0.9965;
/** Per-tick horizontal drag once the cart has left the track. */
const CART_DRAG_OFF = 0.94;
/** Gravity component along a 45 degree track. */
const CART_SLOPE_ACCEL = 11;
/** Powered rail push. */
const CART_POWER_ACCEL = 20;
/** Unpowered powered-rail brake, per tick. */
const CART_BRAKE = 0.5;
/** Speed a stationary cart gets when a powered rail shoves it off a block. */
const CART_LAUNCH_SPEED = 3.2;
/** How hard a rider can nudge a nearly-stopped cart along the track. */
const CART_RIDER_PUSH = 3.0;
const CART_FURNACE_ACCEL = 5.0;
/** A stoked furnace cart chugs; it does not race. */
const CART_FURNACE_SPEED = 5.0;
/** Ticks of push per coal, matching the vanilla furnace minecart. */
const CART_FUEL_PER_COAL = 3600;
const CART_FUEL_MAX = 32000;
const TNT_CART_FUSE = 80;

/** Seconds of sitting still before a mounted rider may hop out again. */
const DISMOUNT_GRACE_TICKS = 4;

const RAND = new RNG(0x5ea1b0a7);

const _box = new AABB();
const _box2 = new AABB();
const _seat = { x: 0, y: 0, z: 0 };

// ---------------------------------------------------------------------------
// Block ids. blocks.js is a static import so its registry is complete here.
// ---------------------------------------------------------------------------
const idOf = (name) => { const d = blockByName(name); return d ? d.id : -1; };

const ID_RAIL = idOf('rail');
const ID_POWERED_RAIL = idOf('powered_rail');
const ID_DETECTOR_RAIL = idOf('detector_rail');
const ID_ACTIVATOR_RAIL = idOf('activator_rail');

/** Every rail id, for the cheap "am I on a track" test. */
const RAIL_IDS = new Set([ID_RAIL, ID_POWERED_RAIL, ID_DETECTOR_RAIL, ID_ACTIVATOR_RAIL].filter((i) => i > 0));

/**
 * The two ends every rail shape connects to, as [dx, rise, dz] where `rise` is
 * 1 when that end sits a whole block higher (an ascending rail).
 *
 * 0 north-south, 1 east-west, 2..5 ascending east/west/north/south,
 * 6 south-east, 7 south-west, 8 north-west, 9 north-east.
 */
const RAIL_CONNECT = [
  [[0, 0, -1], [0, 0, 1]],
  [[-1, 0, 0], [1, 0, 0]],
  [[-1, 0, 0], [1, 1, 0]],
  [[-1, 1, 0], [1, 0, 0]],
  [[0, 1, -1], [0, 0, 1]],
  [[0, 0, -1], [0, 1, 1]],
  [[0, 0, 1], [1, 0, 0]],
  [[0, 0, 1], [-1, 0, 0]],
  [[0, 0, -1], [-1, 0, 0]],
  [[0, 0, -1], [1, 0, 0]],
];

/** Boat woods that have a matching skin in render/skins.js. */
export const BOAT_VARIANTS = [
  'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry',
  'bamboo', 'crimson', 'warped',
];

/**
 * The five minecart flavours plus the spawner cart mineshafts use.
 * `slots` of 0 means the cart carries no inventory.
 */
export const MINECART_TYPES = {
  minecart: { item: 'minecart', slots: 0, seats: 1, display: 'Minecart' },
  chest_minecart: { item: 'chest_minecart', extra: 'chest', slots: 27, seats: 0, display: 'Minecart with Chest' },
  furnace_minecart: { item: 'furnace_minecart', extra: 'furnace', slots: 0, seats: 0, display: 'Minecart with Furnace' },
  hopper_minecart: { item: 'hopper_minecart', extra: 'hopper', slots: 5, seats: 0, display: 'Minecart with Hopper' },
  tnt_minecart: { item: 'tnt_minecart', extra: 'tnt', slots: 0, seats: 0, display: 'Minecart with TNT' },
  spawner_minecart: { item: 'minecart', extra: 'spawner', slots: 0, seats: 0, display: 'Minecart with Spawner' },
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

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

/** Height of a fluid column, matching the mesher's rule exactly. */
function fluidHeight(meta) {
  if (meta & 8) return 1;
  return (8 - (meta & 7)) / 9;
}

/** An item name that definitely exists, or the fallback. */
function safeItem(name, fallback) {
  try { if (itemExists(name)) return name; } catch { /* registry still loading */ }
  return fallback;
}

/**
 * `combat.damageEntity` never calls `entity.hurt()`; it edits health directly.
 * It does consult `entity.def.onHurt`, so that hook is how a non-mob entity
 * reacts to being punched. Both classes below install one that forwards to
 * their own `hurt()` and then reports the hit as fully resolved.
 */
function damageHookDef(name) {
  return {
    name,
    notAMob: true,
    onHurt: (self, amount, src) => {
      try { self.hurt(amount, src); } catch (e) { console.error('[vehicles] hurt hook failed', e); }
      return false;
    },
  };
}

/** Highest water surface inside a box, or -Infinity when it holds no water. */
function waterSurfaceIn(world, box) {
  if (!world) return -Infinity;
  let top = -Infinity;
  const x0 = Math.floor(box.x0 + 0.001), x1 = Math.floor(box.x1 - 0.001);
  const z0 = Math.floor(box.z0 + 0.001), z1 = Math.floor(box.z1 - 0.001);
  const y0 = Math.max(0, Math.floor(box.y0 - 0.001));
  const y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(box.y1 + 0.001));
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const v = world.getRaw(x, y, z);
        const id = v & ID_MASK;
        if (id === 0) continue;
        const def = getBlock(id);
        if (def.liquid !== 'water') continue;
        const h = y + fluidHeight((v >>> 12) & 15);
        if (h > top) top = h;
      }
    }
  }
  return top;
}

/** True when nothing solid overlaps the box an entity of this size would fill. */
function fitsAt(world, width, height, x, y, z) {
  if (!world) return true;
  const hw = width * 0.5;
  _box2.set(x - hw + 0.02, y + 0.02, z - hw + 0.02, x + hw - 0.02, y + height - 0.02, z + hw - 0.02);
  try {
    if (typeof world.getCollisionBoxes === 'function') return world.getCollisionBoxes(_box2, []).length === 0;
  } catch { /* fall through */ }
  return true;
}

/** Slipperiness of whatever the entity is standing on (ice is 0.98). */
function groundSlipperiness(world, e) {
  if (!world) return 0.6;
  const id = world.getBlock(Math.floor(e.x), Math.floor(e.y - 0.2), Math.floor(e.z));
  if (!id) return 0.6;
  const d = getBlock(id);
  return d && typeof d.slipperiness === 'number' ? d.slipperiness : 0.6;
}

/** True when the block is a full solid cube a powered rail can push off. */
function solidAt(world, x, y, z) {
  if (!world) return false;
  const d = getBlock(world.getBlock(x, y, z));
  return !!d && d.solid && d.collision === 'full';
}

/** Drops a list of stacks through itementity.js, waiting for it if need be. */
function spill(world, x, y, z, stacks) {
  if (!world || !stacks || !stacks.length) return;
  const emit = (m) => {
    try {
      if (typeof m.dropStacks === 'function') m.dropStacks(world, x, y, z, stacks);
      else if (typeof m.dropItem === 'function') {
        for (const s of stacks) if (!isEmpty(s)) m.dropItem(world, x, y, z, s);
      }
    } catch (e) { console.error('[vehicles] drop failed', e); }
  };
  if (_itementity) { emit(_itementity); return; }
  // Broken up before the drop module finished loading: wait for it rather than
  // silently swallowing the player's boat.
  try {
    import('./itementity.js').then((m) => { _itementity = m; emit(m); }).catch(() => { /* optional */ });
  } catch { /* no dynamic import */ }
}

/** Opens a container screen for a vehicle inventory. Returns true when a UI took it. */
function openContainer(player, vehicle, inv) {
  const screens = Game.ui && Game.ui.screens;
  if (!screens || typeof screens.open !== 'function' || !inv) return false;
  const name = inv.size <= 5 ? 'hopper' : 'chest';
  try {
    screens.open(name, {
      player: player || Game.player,
      entity: vehicle,
      container: inv,
      inventory: inv,
      items: inv.slots,
      size: inv.size,
      title: inv.name || vehicle.display || 'Container',
    });
    return true;
  } catch (e) {
    console.error('[vehicles] could not open container screen', e);
    return false;
  }
}

/** Shrinks the player's held stack by one outside creative. */
function shrinkHeld(player, stack) {
  if (!player || isEmpty(stack)) return;
  if (player.gameMode === 'creative') return;
  stack.count -= 1;
  if (stack.count <= 0 && player.inventory && typeof player.inventory.set === 'function') {
    try {
      const inv = player.inventory;
      for (let i = 0; i < inv.size; i++) if (inv.slots[i] === stack) { inv.set(i, null); break; }
    } catch { /* best effort */ }
  }
}

// ===========================================================================
// Riding
// ===========================================================================

/**
 * True when `vehicle` is already carried (directly or indirectly) by `rider`.
 * Stops a boat being put inside the minecart that is riding it.
 */
function wouldLoop(rider, vehicle) {
  let v = vehicle;
  for (let i = 0; i < 8 && v; i++) {
    if (v === rider) return true;
    v = v.riding || null;
  }
  return false;
}

/**
 * Seats `entity` on `vehicle`.
 *
 * Works for anything that keeps a `passengers` array - the Boat and Minecart
 * below, and the horses/pigs/striders/camels in mobs.js, which use the same
 * two fields.
 * @returns {boolean} true when the rider actually took a seat
 */
export function mount(entity, vehicle) {
  if (!entity || !vehicle || entity === vehicle) return false;
  if (entity.removed || vehicle.removed || vehicle.dead) return false;
  if (wouldLoop(entity, vehicle)) return false;
  if (entity.riding === vehicle) return true;
  if (entity.riding) dismount(entity);

  const list = Array.isArray(vehicle.passengers) ? vehicle.passengers : (vehicle.passengers = []);
  const seats = seatCount(vehicle);
  if (list.length >= seats) return false;
  if (typeof vehicle.canAddPassenger === 'function') {
    let ok = true;
    try { ok = !!vehicle.canAddPassenger(entity); } catch { ok = true; }
    if (!ok) return false;
  }

  list.push(entity);
  entity.riding = vehicle;
  entity.vehicle = vehicle;
  entity.ridingTicks = 0;
  entity.vx = 0; entity.vy = 0; entity.vz = 0;
  entity.fallDistance = 0;
  entity.onGround = false;
  entity.sprinting = false;
  // Remembered so dismounting restores whatever the rider had before.
  if (entity._preRidePushable === undefined) entity._preRidePushable = entity.pushable !== false;
  entity.pushable = false;

  try { vehicle.onPassengerAdded?.(entity); } catch (e) { console.error('[vehicles] onPassengerAdded', e); }
  if (typeof vehicle.positionPassengers === 'function') {
    try { vehicle.positionPassengers(); } catch { /* optional */ }
  }
  return true;
}

/**
 * Takes `entity` out of whatever it is riding and puts it down somewhere it
 * fits, preferring the vehicle's left, right, back then front.
 * @returns {boolean} true when it had been riding something
 */
export function dismount(entity) {
  if (!entity) return false;
  const vehicle = entity.riding || entity.vehicle || null;
  entity.riding = null;
  entity.vehicle = null;
  entity.ridingTicks = 0;
  if (entity._preRidePushable !== undefined) {
    entity.pushable = entity._preRidePushable;
    entity._preRidePushable = undefined;
  }
  if (!vehicle) return false;

  const list = vehicle.passengers;
  if (Array.isArray(list)) {
    const i = list.indexOf(entity);
    if (i >= 0) list.splice(i, 1);
  }

  const world = entity.world || vehicle.world;
  const spot = findDismountSpot(world, entity, vehicle);
  entity.x = spot.x; entity.y = spot.y; entity.z = spot.z;
  entity.px = spot.x; entity.py = spot.y; entity.pz = spot.z;
  entity.vx = 0; entity.vz = 0;
  if (entity.vy < 0) entity.vy = 0;
  entity.fallDistance = 0;
  if (world && typeof world.onEntityMoved === 'function') {
    try { world.onEntityMoved(entity); } catch { /* optional */ }
  }
  try { vehicle.onPassengerRemoved?.(entity); } catch (e) { console.error('[vehicles] onPassengerRemoved', e); }
  return true;
}

/** Somewhere next to the vehicle the rider's box actually fits. */
function findDismountSpot(world, rider, vehicle) {
  const w = rider.width || 0.6;
  const h = rider.height || 1.8;
  const yaw = vehicle.yaw || 0;
  const fx = -Math.sin(yaw), fz = Math.cos(yaw);
  const rx = -Math.cos(yaw), rz = -Math.sin(yaw);
  const reach = (vehicle.width || 1) * 0.5 + w * 0.5 + 0.15;
  const dirs = [
    [rx * reach, rz * reach], [-rx * reach, -rz * reach],
    [-fx * reach, -fz * reach], [fx * reach, fz * reach],
  ];
  const baseY = vehicle.y + (vehicle.height || 0.6) * 0.2;
  const levels = [0, 1, -1];
  for (let li = 0; li < levels.length; li++) {
    const y = baseY + levels[li];
    for (let i = 0; i < dirs.length; i++) {
      const x = vehicle.x + dirs[i][0];
      const z = vehicle.z + dirs[i][1];
      if (fitsAt(world, w, h, x, y, z)) return { x, y, z };
    }
  }
  // Nothing fits: drop the rider on top of the vehicle rather than inside a wall.
  return { x: vehicle.x, y: vehicle.y + (vehicle.height || 0.6) + 0.05, z: vehicle.z };
}

/** How many riders this vehicle takes. */
function seatCount(vehicle) {
  if (typeof vehicle.seatCount === 'function') {
    try { const n = vehicle.seatCount(); if (Number.isFinite(n)) return n; } catch { /* fall through */ }
  }
  if (Number.isFinite(vehicle.maxPassengers)) return vehicle.maxPassengers;
  if (Number.isFinite(vehicle.seats)) return vehicle.seats;
  return 1;
}

/** Everything currently riding `e`, never null. */
export function passengersOf(e) {
  return e && Array.isArray(e.passengers) ? e.passengers : [];
}

/** True when `rider` is riding `vehicle` (or anything, when vehicle is omitted). */
export function isRiding(rider, vehicle) {
  if (!rider) return false;
  const v = rider.riding || rider.vehicle || null;
  return vehicle === undefined ? !!v : v === vehicle;
}

/** The outermost thing in a rider stack: a player on a horse in a boat -> the boat. */
export function rootVehicle(e) {
  let v = e;
  for (let i = 0; i < 8 && v && v.riding; i++) v = v.riding;
  return v || e;
}

/** Throws every passenger off a vehicle. Returns how many were ejected. */
export function ejectPassengers(vehicle) {
  if (!vehicle || !Array.isArray(vehicle.passengers)) return 0;
  const list = vehicle.passengers.slice();
  for (let i = 0; i < list.length; i++) dismount(list[i]);
  vehicle.passengers.length = 0;
  return list.length;
}

/** Movement intent a rider is feeding its vehicle. */
function riderControls(rider) {
  if (!rider) return { forward: 0, strafe: 0, jump: false, sneak: false, yaw: 0, pitch: 0 };
  return {
    forward: clamp(rider.moveForward || 0, -1, 1),
    strafe: clamp(rider.moveStrafe || 0, -1, 1),
    jump: !!(rider.jumping || rider.wantsJump),
    sneak: !!rider.sneaking,
    yaw: rider.yaw || 0,
    pitch: rider.pitch || 0,
  };
}

/**
 * True exactly once per fresh right-click by this rider.
 *
 * player.js parks `useCooldown` at its place delay on every use and ticks it
 * back down, so a rising edge is a new click. `wantsBoost` lets any other
 * module trigger the same thing explicitly.
 */
function boostClicked(rider) {
  if (!rider) return false;
  if (rider.wantsBoost) { rider.wantsBoost = false; return true; }
  const cd = rider.useCooldown || 0;
  const prev = rider._vehLastUseCd || 0;
  rider._vehLastUseCd = cd;
  return cd > prev;
}

/** Damages a steering item by one point, breaking it when it runs out. */
function damageSteeringItem(rider, held) {
  if (!rider || isEmpty(held)) return;
  if (rider.gameMode === 'creative') return;
  held.damage = (held.damage | 0) + 1;
  let max = 0;
  if (held.item === 'carrot_on_a_stick') max = 25;
  else if (held.item === 'warped_fungus_on_a_stick') max = 100;
  if (max && held.damage >= max) {
    held.count = 0;
    playAt(rider.world, 'item_break', rider.x, rider.y, rider.z, 0.8, 0.9);
  }
}

/**
 * The mixin every rideable thing shares.
 *
 * Call it as a function to install the methods (`Rideable(Boat)`,
 * `Rideable(Horse.prototype)`) or spread it (`Object.assign(proto, Rideable)`)
 * - a function's own methods are enumerable, so both spellings copy exactly
 * the same set. Keys the target already defines are left alone unless
 * `{ force: true }` is passed, so mobs.js keeps its own `mount`/`dismount`.
 *
 * @param {Function|object} target a class, a prototype or a live instance
 * @param {{force?:boolean, seats?:number}} [opts]
 * @returns {Function|object} the target, for chaining
 */
export function Rideable(target, opts = {}) {
  if (!target) return target;
  const proto = typeof target === 'function' ? target.prototype : target;
  if (!proto) return target;
  const force = !!opts.force;
  for (const key of Object.keys(Rideable)) {
    if (!force && key in proto) continue;
    proto[key] = Rideable[key];
  }
  if (Number.isFinite(opts.seats)) proto.maxPassengers = opts.seats;
  if (!Array.isArray(proto.passengers) && !('passengers' in proto)) proto.passengers = null;
  return target;
}

// --- the mixin body. Every one of these lands on the target prototype. ------

/** Default seat count; a chest boat overrides it to 1, a raft to 2. */
Rideable.maxPassengers = 1;

/** How many riders this thing takes right now. */
Rideable.seatCount = function seatCountImpl() {
  return Number.isFinite(this.seats) ? this.seats : (this.maxPassengers | 0) || 1;
};

/** Number of riders currently aboard. */
Rideable.passengerCount = function passengerCount() {
  return Array.isArray(this.passengers) ? this.passengers.length : 0;
};

/** True when at least one seat is free. */
Rideable.hasRoom = function hasRoom() { return this.passengerCount() < this.seatCount(); };

/** The rider in the driving seat, or null. */
Rideable.getDriver = function getDriver() {
  const list = this.passengers;
  return Array.isArray(list) && list.length ? list[0] : null;
};

/** Rider `i`, or null. */
Rideable.getPassenger = function getPassenger(i) {
  const list = this.passengers;
  return Array.isArray(list) && i >= 0 && i < list.length ? list[i] : null;
};

/** Seats a rider. */
Rideable.mountRider = function mountRider(rider) { return mount(rider, this); };

/** Removes one rider. */
Rideable.dismountRider = function dismountRider(rider) {
  if (!rider || (rider.riding !== this && rider.vehicle !== this)) return false;
  return dismount(rider);
};

/** Throws everyone off. */
Rideable.ejectPassengers = function ejectAll() { return ejectPassengers(this); };

/** Vehicle-specific veto on a would-be rider. */
Rideable.canAddPassenger = function canAddPassenger(rider) {
  return !!rider && !rider.removed && !(rider.type === 'ender_dragon' || rider.type === 'wither');
};

/**
 * Where rider `index` sits, in world coordinates.
 * The default puts a single rider on the entity's back.
 */
Rideable.getSeatOffset = function getSeatOffset(index, out) {
  const o = out || { x: 0, y: 0, z: 0 };
  const yaw = this.yaw || 0;
  const fx = -Math.sin(yaw), fz = Math.cos(yaw);
  const back = index * -0.7;
  o.x = this.x + fx * back;
  o.y = this.y + (this.mountedHeight !== undefined ? this.mountedHeight : (this.height || 1) * 0.75);
  o.z = this.z + fz * back;
  return o;
};

/**
 * Pins every rider to its seat and cancels the movement its own physics just
 * produced. Called from the vehicle's update, after the vehicle has moved.
 */
Rideable.positionPassengers = function positionPassengers() {
  const list = this.passengers;
  if (!Array.isArray(list) || list.length === 0) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r || r.removed || (r.riding !== this && r.vehicle !== this)) { list.splice(i, 1); continue; }
    const s = this.getSeatOffset(i, _seat);
    // A rider that teleported far away (a portal, a /tp) loses its seat.
    if (Math.abs(r.x - s.x) > 24 || Math.abs(r.z - s.z) > 24 || Math.abs(r.y - s.y) > 24) {
      dismount(r);
      continue;
    }
    r.x = s.x; r.y = s.y; r.z = s.z;
    r.vx = 0; r.vy = 0; r.vz = 0;
    r.onGround = true;
    r.fallDistance = 0;
    r.riding = this;
    r.vehicle = this;
    if (r.ridingTicks === undefined) r.ridingTicks = 0;
    if (this.world && typeof this.world.onEntityMoved === 'function') {
      try { this.world.onEntityMoved(r); } catch { /* optional */ }
    }
  }
};

/** Rotates riders with the hull so the view turns with the boat. */
Rideable.turnPassengers = function turnPassengers(dYaw) {
  if (!dYaw) return;
  const list = this.passengers;
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r) continue;
    r.yaw = (r.yaw || 0) + dYaw;
    if (r.headYaw !== undefined) r.headYaw = r.yaw;
    if (r.bodyYaw !== undefined) r.bodyYaw = r.yaw;
  }
};

/** The driver's movement intent, normalised. */
Rideable.riderControls = function controls() { return riderControls(this.getDriver()); };

/**
 * The shared saddle-and-stick steering horses, pigs, striders and camels use.
 *
 * The mount turns to face wherever the rider is looking, walks when the rider
 * presses forward, and - when the rider holds the matching stick - can be
 * boosted with a right-click at the cost of one durability point.
 *
 * @param {number} dt seconds
 * @param {{speed?:number, boostItem?:string, requireSaddle?:boolean,
 *          jumpStrength?:number, turnToRider?:boolean}} [opts]
 * @returns {boolean} true when the rider was actually driving
 */
Rideable.steerWithRider = function steerWithRider(dt, opts = {}) {
  const rider = this.getDriver();
  if (!rider || !(dt > 0)) { this.boostTicks = 0; return false; }
  const requireSaddle = opts.requireSaddle !== false;
  if (requireSaddle && !this.saddled) return false;

  const c = riderControls(rider);
  if (opts.turnToRider !== false) {
    this.yaw = c.yaw;
    this.headYaw = c.yaw;
    this.bodyYaw = c.yaw;
  }

  const held = typeof rider.getHeldItem === 'function' ? rider.getHeldItem() : null;
  const boostItem = opts.boostItem || 'carrot_on_a_stick';
  const holdingStick = !isEmpty(held) && held.item === boostItem;

  // The stick drives the mount forward on its own, and a click boosts it.
  if (holdingStick && boostClicked(rider) && !(this.boostTicks > 0)) {
    this.boostTicks = 140 + RAND.int(141);
    damageSteeringItem(rider, held);
    playAt(this.world, boostItem === 'warped_fungus_on_a_stick' ? 'strider_idle' : 'pig_idle',
      this.x, this.y, this.z, 0.6, 1.1);
  }
  let boost = 1;
  if (this.boostTicks > 0) {
    this.boostTicks -= dt * TICKS_PER_SECOND;
    if (this.boostTicks < 0) this.boostTicks = 0;
    boost = 1.85;
  }

  const base = (opts.speed || this.moveSpeed || 0.22) * 22;
  let f = c.forward;
  let s = c.strafe;
  if (holdingStick) f = Math.max(f, 1);      // the stick means "go"
  if (!f && !s) { this.rideMoving = false; return true; }
  this.rideMoving = true;

  const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
  let dx = -sy * f + -cy * s;
  let dz = cy * f + -sy * s;
  const len = Math.hypot(dx, dz);
  if (len > 1e-6) { dx /= len; dz /= len; }
  const accel = base * boost * (f < 0 ? 0.5 : 1);
  this.vx += dx * accel * dt;
  this.vz += dz * accel * dt;
  return true;
};

/**
 * The horse charge bar: holding jump winds a jump up, releasing it fires.
 * The charge is mirrored onto the rider so the HUD can draw the bar without
 * knowing what is being ridden.
 * @returns {number} 0..1 charge
 */
Rideable.tickJumpCharge = function tickJumpCharge(dt, opts = {}) {
  const rider = this.getDriver();
  if (!rider) { this.jumpCharge = 0; return 0; }
  const strength = opts.strength || this.jumpStrength || 0.7;
  const holding = !!(rider.jumping || rider.wantsJump);
  let charge = this.jumpCharge || 0;

  if (holding && this.onGround) {
    charge = clamp(charge + dt * 1.6, 0, 1);
  } else if (charge > 0) {
    if (this.onGround) {
      // Vanilla's curve: a full bar clears about 5 blocks on a good horse.
      this.vy = 10.5 * strength * (0.25 + charge * 0.75);
      const c = riderControls(rider);
      if (c.forward > 0) {
        const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
        this.vx += -sy * 3.2 * charge;
        this.vz += cy * 3.2 * charge;
      }
      this.onGround = false;
      this.fallDistance = 0;
      playAt(this.world, 'horse_jump', this.x, this.y, this.z, 0.6, 1);
      if (rider.wantsJump !== undefined) rider.wantsJump = false;
    }
    charge = 0;
  }
  this.jumpCharge = charge;
  rider.jumpCharge = charge;
  return charge;
};

// ===========================================================================
// Boat
// ===========================================================================

/**
 * A boat.
 *
 * Floats by pulling itself towards the real water surface under its hull,
 * paddles with W/S, turns with A/D instead of strafing, slides for a very long
 * way on ice, seats two (one in a chest boat), and breaks into planks and
 * sticks when it is hit hard enough or dropped from a height.
 */
export class Boat extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {{chest?:boolean, variant?:string}} [opts]
   */
  constructor(world, x, y, z, opts = {}) {
    super(world, x, y, z);
    this.type = opts.chest ? 'chest_boat' : 'boat';
    this.isVehicle = true;
    this.isBoat = true;

    this.width = BOAT_WIDTH;
    this.height = BOAT_HEIGHT;
    this.eyeHeight = BOAT_HEIGHT * 0.6;
    this.mountedHeight = -0.02;

    this.hasChest = !!opts.chest;
    this.chested = this.hasChest;
    this.passengers = [];
    this.seats = this.hasChest ? 1 : 2;
    this.maxPassengers = this.seats;

    this.health = 40;
    this.maxHealth = 40;
    this.damageTaken = 0;
    this.hurtDir = 1;
    this.persistent = true;
    this.pushable = false;
    this.gravity = BOAT_GRAVITY;
    this.stepHeight = 0.6;
    this.frictionEnabled = false;      // this class owns its own friction
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.def = damageHookDef('boat');

    // Steering state.
    this.turnVel = 0;
    this.rowing = 0;
    this.paddlePhase = 0;
    this.floating = false;
    this.underwater = false;
    this.waterSurface = -Infinity;
    this.slipperiness = 0.6;
    this._paddleSound = 0;

    this.inventory = null;
    if (this.hasChest) {
      this.inventory = new Inventory(27, 'Boat with Chest');
    }

    this._variant = 'oak';
    this.variant = opts.variant || 'oak';
  }

  /** Wood the hull is made of. Setting it re-picks the model and skin. */
  get variant() { return this._variant; }
  set variant(v) {
    const name = typeof v === 'string' && v ? v : 'oak';
    this._variant = BOAT_VARIANTS.indexOf(name) >= 0 ? name : 'oak';
    this.refreshAppearance();
  }

  /** Keeps model/skin/display in step with the variant and the chest flag. */
  refreshAppearance() {
    const raft = this._variant === 'bamboo';
    const model = this.hasChest ? 'chest_boat' : (raft ? 'raft' : 'boat');
    this.model = model;
    this.modelName = model;
    this.skinName = (this.hasChest ? 'chest_boat_' : 'boat_') + this._variant;
    this.skin = this.skinName;
    this.itemName = this.boatItemName();
    this.display = prettyName(this.itemName);
    if (this.inventory) this.inventory.name = this.display;
  }

  /** The item this boat came from, e.g. `spruce_chest_boat`, `bamboo_raft`. */
  boatItemName() {
    const v = this._variant;
    if (v === 'bamboo') return this.hasChest ? 'bamboo_chest_raft' : 'bamboo_raft';
    return this.hasChest ? `${v}_chest_boat` : `${v}_boat`;
  }

  /** Planks this hull is built from. */
  plankItemName() {
    const v = this._variant;
    return safeItem(`${v}_planks`, 'oak_planks');
  }

  // ---- seating -----------------------------------------------------------

  /**
   * @override two seats, the driver a little forward of centre and the
   * passenger behind, exactly like vanilla's boat.
   */
  getSeatOffset(index, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const yaw = this.yaw || 0;
    const fx = -Math.sin(yaw), fz = Math.cos(yaw);
    const along = this.seats > 1 ? (index === 0 ? 0.2 : -0.6) : 0;
    o.x = this.x + fx * along;
    o.y = this.y + this.mountedHeight;
    o.z = this.z + fz * along;
    return o;
  }

  /** @override a boat will not carry a boss or another boat. */
  canAddPassenger(rider) {
    if (!rider || rider.removed) return false;
    if (rider.isVehicle) return false;
    if (rider.width > 1.4 || rider.height > 2.6) return false;
    return true;
  }

  // ---- interaction -------------------------------------------------------

  /**
   * Right click: board it, or open the chest when sneaking on a chest boat.
   * @returns {boolean} true when the click was consumed
   */
  interact(player, stack) {
    if (!player) return false;
    if (player.riding === this) { dismount(player); return true; }
    if (this.hasChest && (player.sneaking || this.passengerCount() >= this.seats)) {
      if (openContainer(player, this, this.inventory)) {
        playAt(this.world, 'chest_open', this.x, this.y, this.z, 0.6, 1.1);
        return true;
      }
    }
    if (this.hasRoom()) {
      mount(player, this);
      return true;
    }
    return false;
  }

  // ---- per-frame ---------------------------------------------------------

  /** @override buoyancy, paddling and the hull physics. */
  update(dt) {
    if (this.removed) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.prevYaw = this.yaw;
    this._updatedSinceTick = true;

    this.updateEnvironment();
    this.sampleWater();

    const before = this.yaw;
    this.steer(dt);
    this.turnPassengers(angleDiff(before, this.yaw));

    this.buoyancy(dt);
    this.hullFriction(dt);

    // Entity.move() only tries a step-up from a grounded start, and a floating
    // hull is grounded on nothing. Pretending it is lets a boat climb the lip
    // of a shore or an ice sheet instead of pinning itself against the side of
    // the block, which is the whole ice-highway trick.
    if (this.floating) this.onGround = true;
    const s = this.velocityScale || 1;
    this.move(this.vx * dt * s, this.vy * dt * s, this.vz * dt * s);

    this.positionPassengers();
    this.shoveEntities();
    this.animatePaddles(dt);
  }

  /** Works out whether the hull is floating, beached or airborne. */
  sampleWater() {
    const world = this.world;
    this.waterSurface = -Infinity;
    this.floating = false;
    this.underwater = false;
    if (!world) return;
    const box = this.aabb(_box);
    box.expand(-0.05, 0, -0.05);
    box.y1 += 0.1;
    const top = waterSurfaceIn(world, box);
    this.waterSurface = top;
    if (top > this.y + 0.02) {
      this.floating = true;
      this.underwater = top > this.y + this.height;
    }
    this.slipperiness = this.onGround ? groundSlipperiness(world, this) : 0.6;
  }

  /** Reads the driver's keys: W/S paddle, A/D turn the hull. */
  steer(dt) {
    const rider = this.getDriver();
    this.rowing = 0;
    if (!rider || rider.dead) {
      // Unmanned boats coast and slowly stop turning.
      this.turnVel *= Math.pow(0.55, dt * TICKS_PER_SECOND);
      if (Math.abs(this.turnVel) < 1e-3) this.turnVel = 0;
      this.yaw += this.turnVel * dt;
      return;
    }

    const c = riderControls(rider);

    // Sneak hops out, after a moment's grace so the mounting click cannot
    // immediately un-mount you.
    if (c.sneak && (rider.ridingTicks | 0) > DISMOUNT_GRACE_TICKS) {
      dismount(rider);
      return;
    }

    // A/D turn instead of strafing. The rate winds up, which is what makes a
    // boat feel like a boat rather than a car.
    if (c.strafe !== 0) {
      this.turnVel += c.strafe * BOAT_TURN_ACCEL * dt;
      this.turnVel = clamp(this.turnVel, -BOAT_TURN_MAX, BOAT_TURN_MAX);
    } else {
      this.turnVel *= Math.pow(0.5, dt * TICKS_PER_SECOND);
      if (Math.abs(this.turnVel) < 1e-3) this.turnVel = 0;
    }
    this.yaw += this.turnVel * dt;
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.headYaw = this.yaw;
    this.bodyYaw = this.yaw;

    if (c.forward !== 0) {
      const accel = c.forward > 0 ? BOAT_ACCEL : -BOAT_BACK_ACCEL;
      const fx = -Math.sin(this.yaw), fz = Math.cos(this.yaw);
      // On land the hull barely bites; on ice it barely slows down.
      const grip = this.floating ? 1 : (this.onGround ? 0.55 : 0.35);
      this.vx += fx * accel * grip * dt;
      this.vz += fz * accel * grip * dt;
      this.rowing = Math.min(1, Math.abs(c.forward));
    }
    if (c.strafe !== 0) this.rowing = Math.max(this.rowing, 0.6);
  }

  /** Pulls the hull towards the waterline, or lets it fall. */
  buoyancy(dt) {
    if (this.inLava) {
      // Lava does not float a wooden boat; it eats it.
      this.vy -= this.gravity * 0.3 * dt;
      return;
    }
    if (!this.floating) {
      this.vy -= this.gravity * dt;
      if (this.vy < -30) this.vy = -30;
      return;
    }
    const target = this.waterSurface - BOAT_DRAFT;
    const diff = clamp(target - this.y, -1.2, 1.2);
    this.vy += diff * BOAT_BUOYANCY * dt;
    // Still a little gravity so a boat pushed under does not shoot out.
    this.vy -= this.gravity * 0.12 * dt;
    this.vy *= Math.pow(BOAT_WATER_DAMP, dt * TICKS_PER_SECOND);
    this.vy = clamp(this.vy, -6, 6);
    this.fallDistance = 0;
  }

  /** Water, land or ice friction, then the speed clamp. */
  hullFriction(dt) {
    const ticks = dt * TICKS_PER_SECOND;
    let f;
    if (this.floating) f = BOAT_FRICTION_WATER;
    else if (this.onGround) {
      // Ice is the whole point of boat travel: slipperiness 0.98 keeps almost
      // all the momentum, so a boat on packed ice really does fly.
      f = this.slipperiness > 0.9 ? this.slipperiness : BOAT_FRICTION_LAND * (this.slipperiness / 0.6);
      f = clamp(f, 0.05, 0.995);
    } else f = BOAT_FRICTION_AIR;

    const m = Math.pow(f, ticks);
    this.vx *= m;
    this.vz *= m;
    if (Math.abs(this.vx) < 5e-3) this.vx = 0;
    if (Math.abs(this.vz) < 5e-3) this.vz = 0;

    const speed = Math.hypot(this.vx, this.vz);
    if (speed > BOAT_MAX_SPEED) {
      const k = BOAT_MAX_SPEED / speed;
      this.vx *= k; this.vz *= k;
    }
  }

  /** Pushes loose entities out of the hull, and lets mobs climb aboard. */
  shoveEntities() {
    const world = this.world;
    if (!world || typeof world.entitiesInAABB !== 'function') return;
    const box = this.aabb(_box).expand(0.12, 0.05, 0.12);
    let list;
    try {
      list = world.entitiesInAABB(box, (e) => (
        e !== this && !e.removed && !e.riding && e.pushable !== false
      ));
    } catch { return; }
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o.riding === this) continue;
      // A wandering mob that bumps into an empty boat climbs in, exactly like
      // vanilla, which is how you end up ferrying villagers. Rare enough that
      // a passing pig will not steal a boat out from under you.
      if (this.passengerCount() === 0 && o.living && !o.isPlayer && !o.isVehicle &&
          this.canAddPassenger(o) && RAND.chance(0.015)) {
        mount(o, this);
        continue;
      }
      let dx = o.x - this.x, dz = o.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) { dx = RAND.next() - 0.5; dz = RAND.next() - 0.5; }
      else { dx /= d; dz /= d; }
      const push = 2.2 * (1 - Math.min(1, d / (this.width * 0.5 + o.width * 0.5 + 0.2)));
      o.vx += dx * push;
      o.vz += dz * push;
      this.vx -= dx * push * 0.12;
      this.vz -= dz * push * 0.12;
    }
  }

  /** Paddle swing plus the splash the model animation is timed against. */
  animatePaddles(dt) {
    if (this.rowing > 0) {
      this.paddlePhase += dt * 6 * this.rowing;
      this._paddleSound -= dt;
      if (this._paddleSound <= 0) {
        this._paddleSound = 0.55;
        playAt(this.world, this.floating ? 'boat_paddle_water' : 'boat_paddle_land',
          this.x, this.y, this.z, 0.35, 0.9 + RAND.next() * 0.3);
        if (this.floating) {
          particles('splash', this.x, this.waterSurface, this.z, { count: 2, spread: 0.6, vy: 0.6 });
        }
      }
    }
    // Wake trail behind a moving hull.
    if (this.floating && Math.hypot(this.vx, this.vz) > 3 && RAND.chance(0.35)) {
      particles('splash', this.x - this.vx * 0.06, this.waterSurface + 0.02, this.z - this.vz * 0.06,
        { count: 1, spread: 0.35, vy: 0.4 });
    }
  }

  // ---- 20 Hz -------------------------------------------------------------

  /** @override damage decay, lava, drops out of the world, rider bookkeeping. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;

    if (this.damageTaken > 0) this.damageTaken -= 1;
    const list = this.passengers;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (!r || r.removed || r.dead) { if (r) dismount(r); else list.splice(i, 1); continue; }
      r.ridingTicks = (r.ridingTicks | 0) + 1;
    }

    if (this.inLava) {
      particles('smoke', this.x, this.y + 0.3, this.z, { count: 2, vy: 0.8 });
      this.damageTaken += 8;
      if (this.damageTaken > VEHICLE_BREAK_DAMAGE) { this.breakUp(null, false); return; }
    }
    if (this.fireTicks > 0 && (this.age & 7) === 0) this.damageTaken += 4;

    if (this.y < -18) { this.remove(); return; }

    // A boat dropped a long way splinters on landing.
    if (this.fallDistance > 3 && this.onGround) {
      this.breakUp(null, false);
    }
  }

  /** @override boats never take fall damage; they just break (handled in tick). */
  fall(_distance) { /* see tick() */ }

  /**
   * @override accumulates damage the way vanilla does: every hit adds ten
   * times its strength, the boat shakes, and past 40 it comes apart.
   */
  hurt(amount, source = null) {
    if (this.removed || !(amount > 0)) return false;
    const src = source || damageSource('generic');
    const type = src && src.type ? src.type : 'generic';
    if (type === 'out_of_world' || type === 'void') { this.remove(); return true; }
    if (type === 'drown' || type === 'starve' || type === 'fall') return false;

    const attacker = src.entity || src.direct || null;
    if (attacker && attacker.gameMode === 'creative') { this.breakUp(attacker, true); return true; }

    this.damageTaken += amount * 10;
    this.hurtTime = 10;
    this.maxHurtTime = 10;
    this.hurtDir = -this.hurtDir;
    playAt(this.world, 'dig_wood', this.x, this.y, this.z, 0.6, 0.9);
    if (this.damageTaken > VEHICLE_BREAK_DAMAGE) this.breakUp(attacker, false);
    return true;
  }

  /**
   * Comes apart. Drops three planks and two sticks (plus the chest and its
   * contents on a chest boat), unless a creative player did it.
   * @param {object|null} breaker
   * @param {boolean} silentDrops true to destroy without dropping anything
   */
  breakUp(breaker, silentDrops = false) {
    if (this.removed) return;
    const world = this.world;
    const x = this.x, y = this.y + 0.2, z = this.z;
    ejectPassengers(this);
    this.remove();
    if (!world) return;

    playAt(world, 'dig_wood', x, y, z, 1, 0.8);
    particles('block', x, y, z, { count: 14, spread: 0.6 });
    if (silentDrops) return;

    const drops = [];
    const plank = this.plankItemName();
    const s1 = mkStack(plank, 3);
    if (s1) drops.push(s1);
    const s2 = mkStack(safeItem('stick', 'stick'), 2);
    if (s2) drops.push(s2);
    if (this.hasChest) {
      const c = mkStack(safeItem('chest', 'chest'), 1);
      if (c) drops.push(c);
      if (this.inventory) {
        for (let i = 0; i < this.inventory.size; i++) {
          const s = this.inventory.get(i);
          if (!isEmpty(s)) drops.push(copyStack(s));
        }
        this.inventory.clear();
      }
    }
    spill(world, x, y, z, drops);
  }

  /** @override */
  remove() {
    if (!this.removed) ejectPassengers(this);
    super.remove();
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = this.type;
    o.variant = this._variant;
    o.chest = this.hasChest;
    o.damageTaken = this.damageTaken;
    if (this.inventory) o.inventory = this.inventory.serialize();
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.chest !== undefined) {
      this.hasChest = !!obj.chest;
      this.chested = this.hasChest;
      this.seats = this.hasChest ? 1 : 2;
      this.maxPassengers = this.seats;
      if (this.hasChest && !this.inventory) this.inventory = new Inventory(27, 'Boat with Chest');
    }
    if (obj.variant) this.variant = obj.variant;
    else this.refreshAppearance();
    if (obj.damageTaken !== undefined) this.damageTaken = obj.damageTaken;
    if (obj.inventory && this.inventory) this.inventory.load(obj.inventory);
    return this;
  }

  /**
   * @override the chest flag has to reach the constructor, because it decides
   * how many seats the hull has and whether it owns an inventory at all.
   */
  static deserialize(obj, world) {
    const o = obj || {};
    const e = new Boat(world, o.x || 0, o.y || 0, o.z || 0, {
      chest: !!(o.chest || o.type === 'chest_boat'),
      variant: o.variant || 'oak',
    });
    e.load(o);
    return e;
  }
}
Rideable(Boat);

// ===========================================================================
// Minecart
// ===========================================================================

/**
 * A minecart.
 *
 * On a rail it is driven entirely by the track: the hull is snapped onto the
 * line between the rail's two connection points, momentum is projected onto
 * that line, slopes pull on it, powered rails push or brake it, detector rails
 * light up under it and activator rails set off whatever it is carrying. Off
 * the rails it falls and slides like anything else.
 */
export class Minecart extends Entity {
  /**
   * @param {object} world
   * @param {number} x @param {number} y @param {number} z
   * @param {string} [cartType] one of MINECART_TYPES
   */
  constructor(world, x, y, z, cartType = 'minecart') {
    super(world, x, y, z);
    const spec = MINECART_TYPES[cartType] || MINECART_TYPES.minecart;
    this.cartType = MINECART_TYPES[cartType] ? cartType : 'minecart';
    this.spec = spec;
    this.type = this.cartType;
    this.isVehicle = true;
    this.isMinecart = true;

    this.width = CART_WIDTH;
    this.height = CART_HEIGHT;
    this.eyeHeight = CART_HEIGHT * 0.6;
    this.mountedHeight = 0.06;

    this.model = 'minecart';
    this.modelName = 'minecart';
    this.skinName = 'minecart';
    this.skin = 'minecart';
    this.display = spec.display;
    this.contents = !!spec.extra;
    this.hasContents = this.contents;

    this.passengers = [];
    this.seats = spec.seats | 0;
    this.maxPassengers = this.seats;

    this.health = 40;
    this.maxHealth = 40;
    this.damageTaken = 0;
    this.hurtDir = 1;
    this.persistent = true;
    this.pushable = false;
    this.gravity = GRAVITY;
    this.stepHeight = 0;
    this.frictionEnabled = false;
    this.canBreatheUnderwater = true;
    this.noFallDamage = true;
    this.def = damageHookDef(this.cartType);

    // Track state.
    this.onRail = false;
    this.railShape = 0;
    this.railName = 'rail';
    this.railX = 0; this.railY = 0; this.railZ = 0;
    this.derailed = true;
    this._detectorKey = null;
    this._wasActivated = false;
    this._rideSound = 0;

    // Cargo.
    this.inventory = spec.slots > 0 ? new Inventory(spec.slots, spec.display) : null;
    this.fuel = 0;
    this.pushX = 0;
    this.pushZ = 0;
    this.fuse = -1;
    this.primed = false;
    this.enabled = true;
    this.transferCooldown = 0;
    this.spawnerMob = null;
    this.lootTable = null;
  }

  /** The item that gives this cart back. */
  cartItemName() { return safeItem(this.spec.item, 'minecart'); }

  // ---- seating -----------------------------------------------------------

  /** @override the rider sits down in the tub. */
  getSeatOffset(index, out) {
    const o = out || { x: 0, y: 0, z: 0 };
    o.x = this.x;
    o.y = this.y + this.mountedHeight;
    o.z = this.z;
    return o;
  }

  /** @override only the plain minecart carries anybody. */
  canAddPassenger(rider) {
    if (this.seats <= 0) return false;
    if (!rider || rider.removed || rider.isVehicle) return false;
    return rider.width <= 1.4 && rider.height <= 2.6;
  }

  // ---- interaction -------------------------------------------------------

  /**
   * Right click: ride it, open its container, fuel a furnace cart or light a
   * TNT cart.
   * @returns {boolean} true when the click was consumed
   */
  interact(player, stack) {
    if (!player) return false;
    if (player.riding === this) { dismount(player); return true; }
    const item = !isEmpty(stack) ? stack.item : null;

    if (this.cartType === 'furnace_minecart') {
      const add = item === 'coal' || item === 'charcoal'
        ? CART_FUEL_PER_COAL
        : (item ? Math.round(fuelTicks(item) * 2.25) : 0);
      if (add > 0) {
        this.fuel = Math.min(CART_FUEL_MAX, this.fuel + add);
        // The cart remembers which way it was facing when it was stoked.
        this.pushX = -Math.sin(player.yaw || 0);
        this.pushZ = Math.cos(player.yaw || 0);
        shrinkHeld(player, stack);
        playAt(this.world, 'fire', this.x, this.y, this.z, 0.5, 1.2);
        return true;
      }
      return false;
    }

    if (this.cartType === 'tnt_minecart') {
      if (item === 'flint_and_steel' || item === 'fire_charge') {
        this.prime();
        if (item === 'fire_charge') shrinkHeld(player, stack);
        return true;
      }
      return false;
    }

    if (this.inventory) {
      if (openContainer(player, this, this.inventory)) {
        playAt(this.world, 'chest_open', this.x, this.y, this.z, 0.6, 1.1);
        return true;
      }
      return false;
    }

    if (this.hasRoom()) { mount(player, this); return true; }
    return false;
  }

  // ---- per-frame ---------------------------------------------------------

  /** @override rail following, or ordinary physics once it has derailed. */
  update(dt) {
    if (this.removed) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.prevYaw = this.yaw;
    this._updatedSinceTick = true;

    this.updateEnvironment();

    const rail = findRail(this.world, this.x, this.y, this.z);
    if (rail) this.rideRail(dt, rail);
    else this.freeMove(dt);

    this.positionPassengers();
    this.collideWithCarts();
    this.shoveEntities();
    this.trackEffects(dt);
  }

  /** One frame of track-guided motion. */
  rideRail(dt, rail) {
    this.onRail = true;
    this.derailed = false;
    this.railShape = rail.shape;
    this.railName = rail.name;
    this.railX = rail.x; this.railY = rail.y; this.railZ = rail.z;
    this.onGround = true;
    this.fallDistance = 0;

    const seg = railSegment(rail);
    // Snap the hull onto the rail line before doing anything else.
    let t = clamp(dotOnSegment(this.x, this.y, this.z, seg), 0, seg.len);
    this.x = seg.p1x + seg.dx * t;
    this.y = seg.p1y + seg.dy * t;
    this.z = seg.p1z + seg.dz * t;

    // Signed speed along the rail direction.
    let speed = this.vx * seg.dx + this.vy * seg.dy + this.vz * seg.dz;
    if (!Number.isFinite(speed)) speed = 0;

    speed = this.applyRailForces(dt, rail, seg, speed);
    speed = clamp(speed, -CART_MAX_SPEED, CART_MAX_SPEED);

    // Move along the track, hopping into the next rail block when we run off
    // the end of this segment. Sub-stepping keeps curves accurate at speed.
    // `moved` comes back as the unit direction actually travelled.
    const moved = this.advanceOnRail(speed * dt, seg.dx, seg.dy, seg.dz);
    const mag = Math.abs(speed);
    this.vx = moved.dx * mag;
    this.vy = moved.dy * mag;
    this.vz = moved.dz * mag;

    // Point the cart down the track. Both headings look the same on a
    // minecart, so keep whichever is closer to the one it already had.
    const alignX = mag > 0.05 ? this.vx : seg.dx;
    const alignZ = mag > 0.05 ? this.vz : seg.dz;
    if (Math.abs(alignX) > 1e-6 || Math.abs(alignZ) > 1e-6) {
      const target = Math.atan2(-alignX, alignZ);
      const flipped = target > 0 ? target - Math.PI : target + Math.PI;
      this.yaw = Math.abs(angleDiff(this.yaw, target)) <= Math.abs(angleDiff(this.yaw, flipped))
        ? target : flipped;
      this.bodyYaw = this.yaw;
      this.headYaw = this.yaw;
    }

    if (this.world && typeof this.world.onEntityMoved === 'function') {
      try { this.world.onEntityMoved(this); } catch { /* optional */ }
    }
    // The cart may have rolled into a different block; power whatever it is
    // standing on *now*, not where it started the frame.
    const now = findRail(this.world, this.x, this.y, this.z);
    if (now) this.updateRailBlockState(now);
    else this.leaveRail();
  }

  /** Slope gravity, rolling resistance, powered rails, riders and fuel. */
  applyRailForces(dt, rail, seg, speedIn) {
    let speed = speedIn;
    const ticks = dt * TICKS_PER_SECOND;

    // Gravity component along the track. seg.dy is sin(slope).
    if (seg.dy !== 0) speed -= CART_SLOPE_ACCEL * seg.dy * dt;

    // Rolling resistance.
    speed *= Math.pow(CART_DRAG, ticks);
    if (this.inWater) speed *= Math.pow(0.94, ticks);

    const powered = rail.plain ? false : railIsPowered(this.world, rail);

    if (rail.id === ID_POWERED_RAIL) {
      if (powered) {
        if (Math.abs(speed) > 0.05) {
          speed += Math.sign(speed) * CART_POWER_ACCEL * dt;
        } else {
          // A stopped cart is shoved away from whichever end is walled off.
          const launch = launchDirection(this.world, rail);
          if (launch !== 0) speed = launch * CART_LAUNCH_SPEED;
        }
      } else {
        speed *= Math.pow(CART_BRAKE, ticks);
        if (Math.abs(speed) < 0.12) speed = 0;
      }
    }

    this.setActivated(rail.id === ID_ACTIVATOR_RAIL && powered);

    // Furnace carts push themselves along the track in their stoked direction.
    // They are the slow workhorse of the rail network, so they get their own
    // (much lower) top speed rather than the powered-rail one.
    if (this.cartType === 'furnace_minecart' && this.fuel > 0 && Math.abs(speed) < CART_FURNACE_SPEED) {
      const along = this.pushX * seg.dx + this.pushZ * seg.dz;
      if (Math.abs(along) > 0.01) speed += Math.sign(along) * CART_FURNACE_ACCEL * dt;
      else if (Math.abs(speed) > 0.05) speed += Math.sign(speed) * CART_FURNACE_ACCEL * 0.5 * dt;
    }

    // A rider can kick a nearly-stopped cart into motion, which is the only
    // way to start one without a powered rail.
    const driver = this.getDriver();
    if (driver && Math.abs(speed) < 2.2) {
      const c = riderControls(driver);
      if (c.forward !== 0) {
        const lookX = -Math.sin(c.yaw), lookZ = Math.cos(c.yaw);
        const along = (lookX * seg.dx + lookZ * seg.dz) * c.forward;
        if (Math.abs(along) > 0.15) speed += Math.sign(along) * CART_RIDER_PUSH * dt;
      }
    }
    return speed;
  }

  /**
   * Walks `distance` blocks along the track, following it from one rail block
   * into the next. Returns the direction it ended up travelling in.
   */
  advanceOnRail(distance, dirX, dirY, dirZ) {
    let remaining = Math.abs(distance);
    let mx = dirX, my = dirY, mz = dirZ;
    if (distance < 0) { mx = -mx; my = -my; mz = -mz; }
    if (remaining < 1e-9) return { dx: mx, dy: my, dz: mz };

    let guard = 12;
    while (remaining > 1e-6 && guard-- > 0) {
      const rail = findRail(this.world, this.x, this.y, this.z);
      if (!rail) break;
      const seg = railSegment(rail);
      const sgn = (mx * seg.dx + my * seg.dy + mz * seg.dz) >= 0 ? 1 : -1;
      mx = seg.dx * sgn; my = seg.dy * sgn; mz = seg.dz * sgn;

      const t = clamp(dotOnSegment(this.x, this.y, this.z, seg), 0, seg.len);
      const toEnd = sgn > 0 ? (seg.len - t) : t;
      const step = Math.min(remaining, toEnd);
      const nt = t + sgn * step;
      this.x = seg.p1x + seg.dx * nt;
      this.y = seg.p1y + seg.dy * nt;
      this.z = seg.p1z + seg.dz * nt;
      remaining -= step;

      if (step >= toEnd - 1e-9) {
        // Nudge over the block boundary so the next lookup finds the next rail.
        this.x += mx * 1e-3;
        this.y += my * 1e-3;
        this.z += mz * 1e-3;
        remaining -= 1e-3;
        if (!findRail(this.world, this.x, this.y, this.z)) break;   // end of the line
      } else break;
    }
    // Anything left over is a cart that ran out of track: let it fly.
    if (remaining > 1e-3) {
      this.x += mx * remaining;
      this.y += my * remaining;
      this.z += mz * remaining;
      this.onRail = false;
      this.derailed = true;
      this.leaveRail();
    }
    return { dx: mx, dy: my, dz: mz };
  }

  /** Ordinary falling/sliding physics once the cart has left the track. */
  freeMove(dt) {
    if (this.onRail) this.leaveRail();
    this.onRail = false;
    this.derailed = true;

    this.vy -= this.gravity * dt;
    if (this.vy < -40) this.vy = -40;
    if (this.inWater) { this.vy += this.gravity * 0.55 * dt; this.vy = clamp(this.vy, -6, 4); }

    const ticks = dt * TICKS_PER_SECOND;
    const f = this.onGround ? Math.pow(CART_DRAG_OFF * (this.slipperiness || 0.6) / 0.6, ticks)
      : Math.pow(0.99, ticks);
    this.vx *= f;
    this.vz *= f;
    if (Math.abs(this.vx) < 5e-3) this.vx = 0;
    if (Math.abs(this.vz) < 5e-3) this.vz = 0;

    this.move(this.vx * dt, this.vy * dt, this.vz * dt);
    if (Math.hypot(this.vx, this.vz) > 0.1) {
      this.yaw = Math.atan2(-this.vx, this.vz);
      this.bodyYaw = this.yaw;
    }
  }

  /** Clears the detector rail this cart was sitting on. */
  leaveRail() {
    this.setDetector(null);
    this.setActivated(false);
  }

  /** Detector rails power up under a cart and drop again when it leaves. */
  updateRailBlockState(rail) {
    if (rail.id === ID_DETECTOR_RAIL) this.setDetector(rail);
    else if (this._detectorKey) this.setDetector(null);
  }

  /** Writes the powered bit on a detector rail, and clears the previous one. */
  setDetector(rail) {
    const world = this.world;
    const key = rail ? `${rail.x},${rail.y},${rail.z}` : null;
    if (key === this._detectorKey) return;
    if (this._detectorKey && world) {
      const p = this._detectorKey.split(',');
      const x = +p[0], y = +p[1], z = +p[2];
      // Another cart may still be standing on it.
      if (!cartOnRail(world, x, y, z, this)) setRailPowered(world, x, y, z, false);
    }
    this._detectorKey = key;
    if (rail && world) setRailPowered(world, rail.x, rail.y, rail.z, true);
  }

  /** Activator rails fire the cart's payload on the rising edge only. */
  setActivated(on) {
    if (!!on === this._wasActivated) return;
    this._wasActivated = !!on;
    if (!on) {
      if (this.cartType === 'hopper_minecart') this.enabled = true;
      return;
    }
    switch (this.cartType) {
      case 'tnt_minecart': this.prime(); break;
      case 'hopper_minecart': this.enabled = false; break;
      case 'minecart': ejectPassengers(this); break;
      default: break;
    }
  }

  /** Elastic momentum exchange with any cart it runs into. */
  collideWithCarts() {
    const world = this.world;
    if (!world || typeof world.entitiesInAABB !== 'function') return;
    const box = this.aabb(_box).expand(0.22, 0.1, 0.22);
    let list;
    try { list = world.entitiesInAABB(box, (e) => e !== this && !e.removed && e.isMinecart); }
    catch { return; }
    if (!list || !list.length) return;

    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      let dx = o.x - this.x, dz = o.z - this.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-4) { dx = RAND.next() - 0.5; dz = RAND.next() - 0.5; d = Math.hypot(dx, dz); }
      dx /= d; dz /= d;

      const v1 = this.vx * dx + this.vz * dz;
      const v2 = o.vx * dx + o.vz * dz;
      // Only trade momentum when they are actually closing on each other.
      if (v1 - v2 > 0.01 || d < 0.9) {
        const k = 0.92;
        this.vx += (v2 - v1) * dx * k;
        this.vz += (v2 - v1) * dz * k;
        o.vx += (v1 - v2) * dx * k;
        o.vz += (v1 - v2) * dz * k;
      }
      // Separation, so a stalled train does not sink into itself.
      const overlap = 1.0 - d;
      if (overlap > 0) {
        const p = overlap * 0.5;
        this.x -= dx * p * 0.5; this.z -= dz * p * 0.5;
        o.x += dx * p * 0.5; o.z += dz * p * 0.5;
      }
    }
  }

  /** Knocks loose entities out of the way, and runs mobs over gently. */
  shoveEntities() {
    const world = this.world;
    if (!world || typeof world.entitiesInAABB !== 'function') return;
    const speed = Math.hypot(this.vx, this.vz);
    if (speed < 0.4) return;
    const box = this.aabb(_box).expand(0.1, 0.05, 0.1);
    let list;
    try {
      list = world.entitiesInAABB(box, (e) => (
        e !== this && !e.removed && !e.riding && !e.isMinecart && e.pushable !== false
      ));
    } catch { return; }
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      let dx = o.x - this.x, dz = o.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-4) continue;
      dx /= d; dz /= d;
      o.vx += dx * Math.min(speed, 6) * 0.5;
      o.vz += dz * Math.min(speed, 6) * 0.5;
    }
  }

  /** Rumble, furnace smoke and the fuse sparks. */
  trackEffects(dt) {
    const speed = Math.hypot(this.vx, this.vy, this.vz);
    if (this.onRail && speed > 1.5) {
      this._rideSound -= dt;
      if (this._rideSound <= 0) {
        this._rideSound = 0.45;
        playAt(this.world, 'minecart_riding', this.x, this.y, this.z,
          clamp(speed / CART_MAX_SPEED, 0.1, 0.6), 0.85 + speed * 0.02);
      }
    }
    if (this.cartType === 'furnace_minecart' && this.fuel > 0 && RAND.chance(dt * 12)) {
      particles('smoke', this.x, this.y + 0.7, this.z, { count: 1, vy: 1.1, spread: 0.15 });
    }
    if (this.primed && RAND.chance(dt * 20)) {
      particles('smoke', this.x, this.y + 0.6, this.z, { count: 1, vy: 0.9, spread: 0.2 });
    }
  }

  // ---- 20 Hz -------------------------------------------------------------

  /** @override fuse, fuel, hopper transfers and damage decay. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;

    if (this.damageTaken > 0) this.damageTaken -= 1;
    if (this.transferCooldown > 0) this.transferCooldown--;

    const list = this.passengers;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (!r || r.removed || r.dead) { if (r) dismount(r); else list.splice(i, 1); continue; }
      r.ridingTicks = (r.ridingTicks | 0) + 1;
      if (r.sneaking && (r.ridingTicks | 0) > DISMOUNT_GRACE_TICKS) dismount(r);
    }

    if (this.cartType === 'furnace_minecart' && this.fuel > 0) {
      this.fuel--;
      if (this.fuel <= 0) playAt(this.world, 'fizz', this.x, this.y, this.z, 0.3, 1.4);
    }

    if (this.primed && this.fuse > 0) {
      this.fuse--;
      if (this.fuse <= 0) { this.explodeNow(); return; }
    }

    if (this.cartType === 'hopper_minecart' && this.enabled) this.hopperTick();

    if (this.inLava) {
      if (this.cartType === 'tnt_minecart') { this.explodeNow(); return; }
      this.damageTaken += 10;
      if (this.damageTaken > VEHICLE_BREAK_DAMAGE) { this.breakUp(null, false); return; }
    }

    if (this.y < -18) this.remove();
  }

  /** Sucks up dropped items and pulls from a container overhead. */
  hopperTick() {
    if (!this.inventory || this.transferCooldown > 0) return;
    const world = this.world;
    if (!world) return;

    // 1. Items lying in or just above the cart.
    if (typeof world.entitiesInAABB === 'function') {
      const box = this.aabb(_box).expand(0.35, 0, 0.35);
      box.y1 += 0.6;
      let list = null;
      try {
        list = world.entitiesInAABB(box, (e) => (
          e && !e.removed && (e.type === 'item' || e.type === 'item_entity') && !isEmpty(e.stack)
        ));
      } catch { list = null; }
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.pickupDelay > 0) continue;
          const left = this.inventory.add(copyStack(it.stack));
          if (isEmpty(left)) { it.remove(); this.transferCooldown = 4; return; }
          if (left.count !== it.stack.count) { it.stack = left; this.transferCooldown = 4; return; }
        }
      }
    }

    // 2. One item per transfer out of a chest sitting above the rail.
    const bx = Math.floor(this.x), by = Math.floor(this.y), bz = Math.floor(this.z);
    for (let dy = 1; dy <= 2; dy++) {
      const be = safeBlockEntity(world, bx, by + dy, bz);
      const src = containerSlots(be);
      if (!src) continue;
      for (let i = 0; i < src.length; i++) {
        const s = src[i];
        if (isEmpty(s)) continue;
        const one = copyStack(s);
        one.count = 1;
        const left = this.inventory.add(one);
        if (isEmpty(left)) {
          s.count -= 1;
          if (s.count <= 0) src[i] = null;
          if (be && be.inventory && typeof be.inventory.markChanged === 'function') be.inventory.markChanged(i);
          this.transferCooldown = 8;
          return;
        }
      }
      break;
    }
  }

  /** Lights a TNT cart's fuse. */
  prime(fuse = TNT_CART_FUSE) {
    if (this.cartType !== 'tnt_minecart' || this.primed) return false;
    this.primed = true;
    this.fuse = fuse;
    playAt(this.world, 'tnt_prime', this.x, this.y, this.z, 0.9, 1);
    return true;
  }

  /** Blows up. A moving cart hits noticeably harder, exactly like vanilla. */
  explodeNow() {
    if (this.removed) return;
    const world = this.world;
    const x = this.x, y = this.y + 0.35, z = this.z;
    const speed = Math.hypot(this.vx, this.vy, this.vz);
    const power = clamp(4 + speed * 0.5, 4, 8);
    ejectPassengers(this);
    this.remove();
    if (!world) return;
    const griefing = !world.gameRules || world.gameRules.mobGriefing !== false;
    try {
      explode(world, x, y, z, power, { fire: false, breakBlocks: griefing, source: this, entity: this });
      return;
    } catch (e) { console.error('[vehicles] minecart explosion failed', e); }
    particles('explosion', x, y, z, { count: 24, spread: 2 });
    playAt(world, 'explode', x, y, z, 1, 1);
  }

  /** @override */
  fall(_distance) { /* carts land with a clatter, not a bruise */ }

  /** @override the same accumulate-and-shatter rule the boat uses. */
  hurt(amount, source = null) {
    if (this.removed || !(amount > 0)) return false;
    const src = source || damageSource('generic');
    const type = src && src.type ? src.type : 'generic';
    if (type === 'out_of_world' || type === 'void') { this.remove(); return true; }
    if (type === 'drown' || type === 'starve' || type === 'fall') return false;

    const attacker = src.entity || src.direct || null;

    // A TNT cart that is already rolling goes off when it is hit.
    if (this.cartType === 'tnt_minecart') {
      if (src.fire || type === 'on_fire' || type === 'lava' || type === 'explosion') { this.explodeNow(); return true; }
      if (Math.hypot(this.vx, this.vz) > 1.5) { this.explodeNow(); return true; }
      if (!this.primed && amount >= 3) { this.prime(); return true; }
    }

    if (attacker && attacker.gameMode === 'creative') { this.breakUp(attacker, true); return true; }

    this.damageTaken += amount * 10;
    this.hurtTime = 10;
    this.maxHurtTime = 10;
    this.hurtDir = -this.hurtDir;
    playAt(this.world, 'anvil_land', this.x, this.y, this.z, 0.4, 1.6);
    if (this.damageTaken > VEHICLE_BREAK_DAMAGE) this.breakUp(attacker, false);
    return true;
  }

  /**
   * Falls apart into a minecart plus whatever it was carrying.
   * @param {object|null} breaker
   * @param {boolean} silentDrops
   */
  breakUp(breaker, silentDrops = false) {
    if (this.removed) return;
    const world = this.world;
    const x = this.x, y = this.y + 0.2, z = this.z;
    this.setDetector(null);
    ejectPassengers(this);
    this.remove();
    if (!world) return;

    playAt(world, 'anvil_land', x, y, z, 0.6, 1.4);
    particles('block', x, y, z, { count: 10, spread: 0.5 });
    if (silentDrops) return;

    const drops = [];
    const base = mkStack('minecart', 1);
    if (base) drops.push(base);
    if (this.spec.extra) {
      // The spawner cart has no item of its own to give back.
      const extraName = safeItem(this.spec.extra, null);
      const extra = extraName ? mkStack(extraName, 1) : null;
      if (extra) drops.push(extra);
    }
    if (this.inventory) {
      for (let i = 0; i < this.inventory.size; i++) {
        const s = this.inventory.get(i);
        if (!isEmpty(s)) drops.push(copyStack(s));
      }
      this.inventory.clear();
    }
    spill(world, x, y, z, drops);
  }

  /** @override */
  remove() {
    if (!this.removed) {
      this.setDetector(null);
      ejectPassengers(this);
    }
    super.remove();
  }

  /** @override */
  serialize() {
    const o = super.serialize();
    o.type = this.cartType;
    o.cartType = this.cartType;
    o.damageTaken = this.damageTaken;
    o.fuel = this.fuel;
    o.pushX = this.pushX;
    o.pushZ = this.pushZ;
    o.primed = this.primed;
    o.fuse = this.fuse;
    o.enabled = this.enabled;
    if (this.spawnerMob) o.spawnerMob = this.spawnerMob;
    if (this.inventory) o.inventory = this.inventory.serialize();
    return o;
  }

  /** @override */
  load(obj) {
    super.load(obj);
    if (!obj) return this;
    if (obj.damageTaken !== undefined) this.damageTaken = obj.damageTaken;
    if (obj.fuel !== undefined) this.fuel = obj.fuel;
    if (obj.pushX !== undefined) this.pushX = obj.pushX;
    if (obj.pushZ !== undefined) this.pushZ = obj.pushZ;
    if (obj.primed !== undefined) this.primed = !!obj.primed;
    if (obj.fuse !== undefined) this.fuse = obj.fuse;
    if (obj.enabled !== undefined) this.enabled = !!obj.enabled;
    if (obj.spawnerMob) this.spawnerMob = obj.spawnerMob;
    if (obj.inventory && this.inventory) this.inventory.load(obj.inventory);
    return this;
  }

  /**
   * @override the cart kind decides the inventory size and seat count, so it
   * has to be known before the constructor runs.
   */
  static deserialize(obj, world) {
    const o = obj || {};
    const t = o.cartType || o.type;
    const e = new Minecart(world, o.x || 0, o.y || 0, o.z || 0,
      MINECART_TYPES[t] ? t : 'minecart');
    e.load(o);
    return e;
  }

  /** Fills a chest cart from a loot table (mineshaft carts). */
  fillLoot(tableName, rng) {
    if (!this.inventory || !_loot || typeof _loot.chestLoot !== 'function') { this.lootTable = tableName; return false; }
    try {
      const items = _loot.chestLoot(tableName, rng || RAND);
      const slots = [];
      for (let i = 0; i < this.inventory.size; i++) slots.push(i);
      (rng || RAND).shuffle(slots);
      for (let i = 0; i < items.length && i < slots.length; i++) this.inventory.set(slots[i], items[i]);
      this.lootTable = null;
      return true;
    } catch (e) {
      console.error('[vehicles] minecart loot failed', e);
      return false;
    }
  }
}
Rideable(Minecart);

// ===========================================================================
// Rails
// ===========================================================================

/**
 * The rail at an exact block position, or null.
 * @returns {{x:number,y:number,z:number,id:number,name:string,shape:number,powered:boolean,plain:boolean}|null}
 */
export function railAt(world, x, y, z) {
  if (!world || y < 0 || y >= WORLD_HEIGHT) return null;
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (!RAIL_IDS.has(id)) return null;
  const meta = (v >>> 12) & 15;
  const plain = id === ID_RAIL;
  // Only plain rails curve, so the special rails can spend bit 3 on power.
  let shape = plain ? (meta & 15) : (meta & 7);
  if (shape > 9) shape = 0;
  return {
    x, y, z, id, meta, plain, shape,
    powered: plain ? false : (meta & 8) !== 0,
    name: getBlock(id).name,
  };
}

/** The rail shape at a block, or -1 when there is no rail there. */
export function railShapeAt(world, x, y, z) {
  const r = railAt(world, Math.floor(x), Math.floor(y), Math.floor(z));
  return r ? r.shape : -1;
}

/** True when this block id is any kind of rail. */
export function isRailId(id) { return RAIL_IDS.has(id); }

/**
 * The rail a cart at this position is riding: the block it is in, or the one
 * below (which is how a cart part-way up a slope finds its track).
 */
function findRail(world, x, y, z) {
  if (!world) return null;
  const bx = Math.floor(x), bz = Math.floor(z);
  const by = Math.floor(y + 1e-4);
  return railAt(world, bx, by, bz) || railAt(world, bx, by - 1, bz);
}

/**
 * The straight line a rail shape represents: from one connection point,
 * through the block, to the other.
 */
function railSegment(rail) {
  const c = RAIL_CONNECT[rail.shape] || RAIL_CONNECT[0];
  const d1 = c[0], d2 = c[1];
  const cx = rail.x + 0.5, cz = rail.z + 0.5;
  const p1x = cx + d1[0] * 0.5, p1y = rail.y + RAIL_H + d1[1], p1z = cz + d1[2] * 0.5;
  const p2x = cx + d2[0] * 0.5, p2y = rail.y + RAIL_H + d2[1], p2z = cz + d2[2] * 0.5;
  let dx = p2x - p1x, dy = p2y - p1y, dz = p2z - p1z;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  return { p1x, p1y, p1z, p2x, p2y, p2z, dx, dy, dz, len };
}

/** Distance along a rail segment for a world position. */
function dotOnSegment(x, y, z, seg) {
  return (x - seg.p1x) * seg.dx + (y - seg.p1y) * seg.dy + (z - seg.p1z) * seg.dz;
}

/** Which way a powered rail should shove a stopped cart: -1, 0 or +1. */
function launchDirection(world, rail) {
  const c = RAIL_CONNECT[rail.shape] || RAIL_CONNECT[0];
  const d1 = c[0], d2 = c[1];
  const s1 = solidAt(world, rail.x + d1[0], rail.y + d1[1], rail.z + d1[2]);
  const s2 = solidAt(world, rail.x + d2[0], rail.y + d2[1], rail.z + d2[2]);
  if (s1 && !s2) return 1;      // walled off behind p1, so travel towards p2
  if (s2 && !s1) return -1;
  return 0;
}

/** Reads a rail's power, preferring redstone.js when it has loaded. */
function railIsPowered(world, rail) {
  if (!rail || rail.plain) return false;
  if (rail.powered) return true;
  if (_redstone && typeof _redstone.isPowered === 'function') {
    try { return !!_redstone.isPowered(world, rail.x, rail.y, rail.z); } catch { /* optional */ }
  }
  return false;
}

/** Flips the powered bit on a detector rail and pokes the redstone graph. */
function setRailPowered(world, x, y, z, on) {
  if (!world) return;
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (!RAIL_IDS.has(id) || id === ID_RAIL) return;
  const meta = (v >>> 12) & 15;
  const want = on ? (meta | 8) : (meta & 7);
  if (want === meta) return;
  try { world.setBlock(x, y, z, id, want, 3); } catch { return; }
  if (_redstone && typeof _redstone.updateRedstone === 'function') {
    try { _redstone.updateRedstone(world, x, y, z); } catch { /* optional */ }
  }
}

/** True when some other minecart is still standing on this rail. */
function cartOnRail(world, x, y, z, ignore) {
  if (!world || typeof world.entitiesInAABB !== 'function') return false;
  _box2.set(x, y - 0.2, z, x + 1, y + 1.2, z + 1);
  try {
    const list = world.entitiesInAABB(_box2, (e) => e !== ignore && !e.removed && e.isMinecart);
    return !!(list && list.length);
  } catch { return false; }
}

/** A block entity, without letting a half-built world module throw. */
function safeBlockEntity(world, x, y, z) {
  if (!world || typeof world.getBlockEntity !== 'function') return null;
  try { return world.getBlockEntity(x, y, z) || null; } catch { return null; }
}

/** The slot array of a container block entity, or null. */
function containerSlots(be) {
  if (!be) return null;
  if (be.inventory && Array.isArray(be.inventory.slots)) return be.inventory.slots;
  if (Array.isArray(be.items)) return be.items;
  return null;
}

// ===========================================================================
// Llama caravans
// ===========================================================================

/** Every llama currently roped into a caravan, so the tick hook stays cheap. */
const CARAVAN = new Set();
/** Distance a follower tries to keep from the llama in front of it. */
const CARAVAN_GAP = 2.0;

/**
 * Ropes `follower` in behind `leader`, the way leashing one llama to another
 * builds a train.
 * @returns {boolean} true when the link was made
 */
export function linkCaravan(follower, leader) {
  if (!follower || !leader || follower === leader) return false;
  if (follower.removed || leader.removed) return false;
  // No loops: walk the chain first.
  let h = leader;
  for (let i = 0; i < 16 && h; i++) {
    if (h === follower) return false;
    h = h.caravanHead || null;
  }
  if (leader.caravanTail && leader.caravanTail !== follower) breakCaravan(leader.caravanTail);
  breakCaravan(follower);
  follower.caravanHead = leader;
  leader.caravanTail = follower;
  follower.leashedTo = null;
  CARAVAN.add(follower);
  return true;
}

/** Cuts a llama out of its caravan. */
export function breakCaravan(llama) {
  if (!llama) return false;
  const head = llama.caravanHead;
  if (head && head.caravanTail === llama) head.caravanTail = null;
  llama.caravanHead = null;
  CARAVAN.delete(llama);
  return !!head;
}

/** How many llamas are following this one, directly or otherwise. */
export function caravanLength(leader) {
  let n = 0;
  let t = leader && leader.caravanTail;
  while (t && n < 16) { n++; t = t.caravanTail; }
  return n;
}

/** Walks one caravan follower towards the llama in front of it. */
function followCaravan(llama) {
  const head = llama.caravanHead;
  if (!head || head.removed || head.dead || head.world !== llama.world) { breakCaravan(llama); return; }
  const dx = head.x - llama.x, dz = head.z - llama.z;
  const d = Math.hypot(dx, dz);
  if (d > 12) { breakCaravan(llama); return; }
  if (d < CARAVAN_GAP) return;
  const t = (d - CARAVAN_GAP * 0.6) / d;
  const tx = llama.x + dx * t;
  const tz = llama.z + dz * t;
  const speed = d > 6 ? 1.6 : 1.0;
  if (typeof llama.moveTo === 'function') {
    try { llama.moveTo(tx, head.y, tz, speed); return; } catch { /* fall through */ }
  }
  // No pathfinder: nudge it directly so a caravan still trails along.
  const nx = dx / (d || 1), nz = dz / (d || 1);
  llama.vx += nx * speed * 1.2;
  llama.vz += nz * speed * 1.2;
  llama.yaw = Math.atan2(-nx, nz);
}

/**
 * Forms and drives llama caravans. Safe to call every tick; it does nothing
 * when there are no llamas around.
 */
export function tickCaravans(world) {
  if (!world) return;
  for (const llama of Array.from(CARAVAN)) {
    if (!llama || llama.removed || llama.dead || llama.world !== world) { CARAVAN.delete(llama); continue; }
    followCaravan(llama);
  }
}

/** Chains together every llama a single holder has leashed. */
function formCaravans(world) {
  if (!world || typeof world.entitiesNear !== 'function') return;
  const anchor = Game.player && Game.player.world === world ? Game.player : null;
  const home = world.spawnPoint || { x: 0, y: 64, z: 0 };
  const ax = anchor ? anchor.x : home.x;
  const ay = anchor ? anchor.y : home.y;
  const az = anchor ? anchor.z : home.z;
  let list;
  try {
    list = world.entitiesNear(ax, ay, az, 32, (e) => (
      e && !e.removed && !e.dead && (e.type === 'llama' || e.type === 'trader_llama')
    ));
  } catch { return; }
  if (!list || list.length < 2) return;

  const byHolder = new Map();
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    if (!l.leashedTo || l.caravanHead) continue;
    let arr = byHolder.get(l.leashedTo);
    if (!arr) { arr = []; byHolder.set(l.leashedTo, arr); }
    arr.push(l);
  }
  for (const arr of byHolder.values()) {
    if (arr.length < 2) continue;
    // The first stays on the lead; everyone else falls in behind.
    for (let i = 1; i < arr.length; i++) linkCaravan(arr[i], arr[i - 1]);
  }
}

// ---------------------------------------------------------------------------
// The 20 Hz driver for anything in this module that is not an entity.
//
// Registering the handler is not a Game *field* read, so it is safe at module
// scope; everything the handler touches is read inside the callback, after
// boot.
// ---------------------------------------------------------------------------
let _caravanScan = 0;
Game.on('tick', () => {
  const world = Game.world;
  if (!world) return;
  if (CARAVAN.size) tickCaravans(world);
  if (--_caravanScan <= 0) {
    _caravanScan = 20;
    try { formCaravans(world); } catch (e) { console.error('[vehicles] caravan scan failed', e); }
  }
});

// ===========================================================================
// Spawning
// ===========================================================================

/** Normalises the many spellings items.js and commands use into one shape. */
function resolveVehicleType(type) {
  const t = String(type || '').replace(/^minecraft:/, '');
  if (MINECART_TYPES[t]) return { kind: 'minecart', cart: t };
  if (t === 'boat' || t === 'raft') return { kind: 'boat', chest: false, variant: t === 'raft' ? 'bamboo' : null };
  if (t === 'chest_boat' || t === 'chest_raft') {
    return { kind: 'boat', chest: true, variant: t === 'chest_raft' ? 'bamboo' : null };
  }
  // `spruce_boat`, `bamboo_chest_raft`, `oak_chest_boat`, ...
  if (t.endsWith('_chest_boat') || t.endsWith('_chest_raft')) {
    return { kind: 'boat', chest: true, variant: t.slice(0, t.indexOf('_chest_')) };
  }
  if (t.endsWith('_boat') || t.endsWith('_raft')) {
    return { kind: 'boat', chest: false, variant: t.slice(0, t.lastIndexOf('_')) };
  }
  if (t.endsWith('_minecart') || t === 'minecart') {
    return { kind: 'minecart', cart: MINECART_TYPES[t] ? t : 'minecart' };
  }
  return null;
}

/**
 * Creates a vehicle and puts it in the world.
 *
 * `type` may be a bare kind (`boat`, `chest_boat`, `minecart`,
 * `tnt_minecart`, ...) or a full item name (`spruce_chest_boat`).
 * @returns {Boat|Minecart|null}
 */
export function spawnVehicle(type, world, x, y, z, opts = {}) {
  if (!world) return null;
  const spec = resolveVehicleType(type);
  if (!spec) return null;

  let e = null;
  try {
    if (spec.kind === 'boat') {
      e = new Boat(world, x, y, z, { chest: spec.chest, variant: opts.variant || spec.variant || 'oak' });
    } else {
      e = new Minecart(world, x, y, z, spec.cart);
      // Drop a fresh cart neatly onto the rail it was placed on.
      const rail = findRail(world, x, y, z);
      if (rail) {
        const seg = railSegment(rail);
        const t = clamp(dotOnSegment(x, y, z, seg), 0, seg.len);
        e.x = seg.p1x + seg.dx * t;
        e.y = seg.p1y + seg.dy * t;
        e.z = seg.p1z + seg.dz * t;
        e.px = e.x; e.py = e.y; e.pz = e.z;
      }
    }
  } catch (err) {
    console.error('[vehicles] could not build', type, err);
    return null;
  }
  if (opts.yaw !== undefined) e.yaw = opts.yaw;
  try { world.addEntity(e); } catch (err) { console.error('[vehicles] addEntity failed', err); return null; }
  return e;
}

/** Convenience wrapper used by structures.js style callers. */
export function spawnBoat(world, x, y, z, variant = 'oak', chest = false) {
  return spawnVehicle(chest ? 'chest_boat' : 'boat', world, x, y, z, { variant });
}

/** Convenience wrapper: a cart of any of the five kinds. */
export function spawnMinecart(world, x, y, z, cartType = 'minecart') {
  return spawnVehicle(cartType, world, x, y, z);
}

/** Every vehicle within `radius` of a point. */
export function vehiclesNear(world, x, y, z, radius) {
  if (!world || typeof world.entitiesNear !== 'function') return [];
  try { return world.entitiesNear(x, y, z, radius, (e) => e && !e.removed && e.isVehicle) || []; }
  catch { return []; }
}

// ===========================================================================
// Registration
// ===========================================================================

registerEntityType('boat', Boat);
registerEntityType('chest_boat', Boat);
for (const name of Object.keys(MINECART_TYPES)) registerEntityType(name, Minecart);

export default {
  Boat, Minecart,
  spawnVehicle, spawnBoat, spawnMinecart, vehiclesNear,
  mount, dismount, ejectPassengers, passengersOf, isRiding, rootVehicle,
  Rideable,
  linkCaravan, breakCaravan, caravanLength, tickCaravans,
  railAt, railShapeAt, isRailId,
  MINECART_TYPES, BOAT_VARIANTS,
};
