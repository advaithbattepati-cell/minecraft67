// ============================================================================
// redstone.js - Power propagation, components, pistons, doors and rails.
//
// The model follows vanilla closely:
//
//   * every component answers two questions - how much power it pushes into a
//     neighbour *weakly* (activates mechanisms) and *strongly* (also lights up
//     dust laid on the receiving block),
//   * a solid opaque cube ("conductor") that is strongly powered re-emits that
//     power to everything touching it,
//   * dust is muted while a wire computes its own input, which is what makes
//     the classic "a block with dust on it powers pistons but not more dust"
//     rule fall out for free.
//
// Everything is driven by one queue per world. `updateRedstone` is called by
// World.setRaw for every block change; it enqueues the affected positions and
// drains the queue with a hard budget, so a redstone clock can never recurse
// into a stack overflow - the leftovers are simply picked up next tick.
// Delayed behaviour (repeater delay, torch inversion, piston movement, button
// release) lives in a per-world timer list ticked from `tickRedstone`.
// ============================================================================

import {
  WORLD_HEIGHT, ID_MASK,
  FACE_DOWN, FACE_UP, FACE_NORTH,
  FACE_DIRS, FACE_OPPOSITE, HFACE_TO_FACE,
} from '../core/constants.js';
import { Game } from '../core/game.js';
import { AABB } from '../core/util.js';
import { BLOCKS, getBlock, blockByName } from './blocks.js';

// ---------------------------------------------------------------------------
// Optional sibling modules. Static imports would close cycles (items -> blocks
// -> ... ) and would let one unfinished module take redstone down with it, so
// they are pulled in lazily and every use site is guarded.
// ---------------------------------------------------------------------------
let _loot = null;
let _itementity = null;
let _projectiles = null;
let _inventory = null;
let _depsStarted = false;

function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, assign) => {
    try {
      import(path).then((m) => { assign(m); }).catch(() => { /* optional */ });
    } catch { /* environment without dynamic import */ }
  };
  grab('../item/loot.js', (m) => { _loot = m; });
  grab('../entity/itementity.js', (m) => { _itementity = m; });
  grab('../entity/projectiles.js', (m) => { _projectiles = m; });
  grab('../item/inventory.js', (m) => { _inventory = m; });
}
loadDeps();

// ---------------------------------------------------------------------------
// Component classification, built once from the block registry
// ---------------------------------------------------------------------------

/** Component kinds. 0 means "not a redstone component". */
const C = {
  NONE: 0, WIRE: 1, REPEATER: 2, COMPARATOR: 3, TORCH: 4, LEVER: 5, BUTTON: 6,
  PLATE: 7, WEIGHTED: 8, HOOK: 9, TRIPWIRE: 10, DAYLIGHT: 11, TARGET: 12,
  ROD: 13, SCULK: 14, OBSERVER: 15, RBLOCK: 16, PISTON: 17, HEAD: 18, LAMP: 19,
  DOOR: 20, TRAPDOOR: 21, GATE: 22, HOPPER: 23, DISPENSER: 24, TNT: 25,
  NOTE: 26, RAIL: 27, PRAIL: 28, DRAIL: 29, ARAIL: 30, MOVING: 31, BELL: 32,
  TCHEST: 33,
};

const NBLOCK = Math.max(BLOCKS.length, 1);
/** Component kind per block id. */
const T_COMP = new Uint8Array(NBLOCK);
/** 1 when the block emits redstone power itself (never counts as a conductor). */
const T_SOURCE = new Uint8Array(NBLOCK);
/** 1 for a full opaque cube that carries strong power to its neighbours. */
const T_COND = new Uint8Array(NBLOCK);
/** Piston reaction: 0 normal, 1 immovable, 2 destroyed when pushed. */
const T_PUSH = new Uint8Array(NBLOCK);
/** 1 slime, 2 honey. */
const T_STICKY = new Uint8Array(NBLOCK);
/** 1 for anything a redstone update has to look at. */
const T_WATCH = new Uint8Array(NBLOCK);

const idOf = (name) => {
  const d = blockByName(name);
  return d ? d.id : -1;
};

const ID_WIRE = idOf('redstone_wire');
const ID_STICKY_PISTON = idOf('sticky_piston');
const ID_PISTON_HEAD = idOf('piston_head');
const ID_DROPPER = idOf('dropper');
const ID_TNT = idOf('tnt');
const ID_NOTE_BLOCK = idOf('note_block');
const ID_TRIPWIRE = idOf('tripwire');
const ID_AIR = 0;

// Blocks a piston must refuse to move even though they look ordinary.
const IMMOVABLE_NAMES = new Set([
  'obsidian', 'crying_obsidian', 'bedrock', 'barrier', 'structure_void',
  'end_portal', 'end_portal_frame', 'end_gateway', 'nether_portal',
  'reinforced_deepslate', 'respawn_anchor', 'enchanting_table', 'dragon_egg',
  'piston_head', 'moving_piston', 'sculk_shrieker', 'trial_spawner', 'spawner',
]);

(function buildTables() {
  for (let id = 0; id < NBLOCK; id++) {
    const d = BLOCKS[id];
    if (!d) continue;
    const n = d.name;
    let c = C.NONE;

    if (n === 'redstone_wire') c = C.WIRE;
    else if (n === 'repeater') c = C.REPEATER;
    else if (n === 'comparator') c = C.COMPARATOR;
    else if (n === 'redstone_torch' || n === 'redstone_wall_torch') c = C.TORCH;
    else if (n === 'lever') c = C.LEVER;
    else if (n === 'tripwire_hook') c = C.HOOK;
    else if (n === 'tripwire') c = C.TRIPWIRE;
    else if (n === 'daylight_detector') c = C.DAYLIGHT;
    else if (n === 'target') c = C.TARGET;
    else if (n === 'lightning_rod') c = C.ROD;
    else if (n === 'sculk_sensor' || n === 'calibrated_sculk_sensor') c = C.SCULK;
    else if (n === 'observer') c = C.OBSERVER;
    else if (n === 'redstone_block') c = C.RBLOCK;
    else if (n === 'piston' || n === 'sticky_piston') c = C.PISTON;
    else if (n === 'piston_head') c = C.HEAD;
    else if (n === 'moving_piston') c = C.MOVING;
    else if (n === 'redstone_lamp') c = C.LAMP;
    else if (n === 'hopper') c = C.HOPPER;
    else if (n === 'dispenser' || n === 'dropper') c = C.DISPENSER;
    else if (n === 'tnt') c = C.TNT;
    else if (n === 'note_block') c = C.NOTE;
    else if (n === 'bell') c = C.BELL;
    else if (n === 'trapped_chest') c = C.TCHEST;
    else if (n === 'rail') c = C.RAIL;
    else if (n === 'powered_rail') c = C.PRAIL;
    else if (n === 'detector_rail') c = C.DRAIL;
    else if (n === 'activator_rail') c = C.ARAIL;
    else if (n === 'light_weighted_pressure_plate' || n === 'heavy_weighted_pressure_plate') c = C.WEIGHTED;
    else if (n.endsWith('_pressure_plate')) c = C.PLATE;
    else if (n.endsWith('_button')) c = C.BUTTON;
    else if (d.model === 'door') c = C.DOOR;
    else if (d.model === 'trapdoor') c = C.TRAPDOOR;
    else if (d.model === 'fence_gate') c = C.GATE;
    T_COMP[id] = c;

    switch (c) {
      case C.WIRE: case C.REPEATER: case C.COMPARATOR: case C.TORCH: case C.LEVER:
      case C.BUTTON: case C.PLATE: case C.WEIGHTED: case C.HOOK: case C.TRIPWIRE:
      case C.DAYLIGHT: case C.TARGET: case C.ROD: case C.SCULK: case C.OBSERVER:
      case C.RBLOCK: case C.DRAIL: case C.TCHEST:
        T_SOURCE[id] = 1;
        break;
      default: break;
    }

    T_COND[id] = (!T_SOURCE[id] && d.solid && d.opaque && d.collision === 'full' && !d.air) ? 1 : 0;

    // Piston reaction.
    let push = 0;
    if (n === 'air' || d.air) push = 0;
    else if (IMMOVABLE_NAMES.has(n) || d.hardness < 0 || d.entityType || d.resistance >= 1000) push = 1;
    else if (d.liquid) push = 2;
    else if (!d.solid || d.collision === 'none') push = 2;
    T_PUSH[id] = push;

    if (n === 'slime_block') T_STICKY[id] = 1;
    else if (n === 'honey_block') T_STICKY[id] = 2;

    T_WATCH[id] = (c !== C.NONE) ? 1 : 0;
  }
})();

// north/east/south/west deltas, indexed by the HFACE constants.
const HDX = [0, 1, 0, -1];
const HDZ = [-1, 0, 1, 0];
/** FACE_* -> HFACE index (-1 for up/down). */
const FACE_TO_HFACE = [-1, -1, 0, 2, 3, 1];

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
/** Blocks one piston may shove. */
const MAX_PUSH = 12;
/** Largest dust network recomputed in one pass. */
const MAX_WIRE_NODES = 4096;
/** Updates drained per synchronous burst (a lever click). */
const IMMEDIATE_BUDGET = 900;
/** Updates drained per world tick. */
const TICK_BUDGET = 2400;
/** Timers fired per world tick. */
const MAX_TIMERS_PER_TICK = 512;
/** How long a pressure plate stays down after the last entity leaves. */
const PLATE_HOLD = 20;
const TRIPWIRE_HOLD = 10;
/** Torch burnout: this many flips inside the window kills it for a while. */
const TORCH_BURN_LIMIT = 8;
const TORCH_BURN_WINDOW = 60;
const TORCH_BURN_TIME = 60;
/** Powered rails carry their signal this far along the track. */
const RAIL_POWER_RANGE = 8;

// Timer kinds.
const T_DIODE = 'd';       // repeater / comparator state flip
const T_TORCH_T = 't';     // torch inversion
const T_PISTON_T = 'p';    // piston extend / retract
const T_LAMP_T = 'l';      // lamp switch-off delay
const T_BUTTON_T = 'b';    // button release
const T_DISPENSE = 'f';    // dispenser / dropper fire
const T_DECAY = 'y';       // target block / lightning rod decay
const T_OBSERVER = 'o';    // observer pulse end
const T_SCULK_T = 's';     // sculk sensor cooldown
const T_UPDATE = 'u';      // plain deferred update (scheduleRedstoneUpdate)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const flr = Math.floor;

/** Collision-free integer key for a block position (|x|,|z| < 2^21). */
function posKey(x, y, z) {
  return ((x & 0x3fffff) * 4194304 + (z & 0x3fffff)) * 128 + (y & 127);
}

function playAt(name, x, y, z, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || typeof a.playAt !== 'function') return;
  try { a.playAt(name, x, y, z, volume, pitch); } catch { /* audio is optional */ }
}

function particles(type, x, y, z, opts) {
  const p = Game.particles;
  if (!p || typeof p.spawn !== 'function') return;
  try { p.spawn(type, x, y, z, opts || {}); } catch { /* particles are optional */ }
}

/** Block id, tolerating a missing world. */
function idAt(world, x, y, z) {
  if (y < 0 || y >= WORLD_HEIGHT) return 0;
  return world.getBlock(x, y, z) & ID_MASK;
}

/** Metadata nibble. */
function metaAt(world, x, y, z) {
  if (y < 0 || y >= WORLD_HEIGHT) return 0;
  return world.getMeta(x, y, z) & 15;
}

/** Rewrites metadata only when it actually differs. */
function setMeta(world, x, y, z, id, meta, flags = 3) {
  const v = world.getRaw(x, y, z);
  if ((v & ID_MASK) !== id) return false;
  if (((v >>> 12) & 15) === (meta & 15)) return false;
  return world.setBlock(x, y, z, id, meta & 15, flags);
}

/** True when the block at this position is a full opaque cube carrying power. */
export function isConductor(world, x, y, z) {
  if (!world) return false;
  if (y < 0) return true;                        // the bedrock floor conducts
  if (y >= WORLD_HEIGHT) return false;
  return T_COND[idAt(world, x, y, z)] === 1;
}

const isCondId = (id) => T_COND[id] === 1;

/** The face pointing from a floor/wall/ceiling mounted part toward its support. */
function mountSupportFace(m) {
  if (m === 0) return FACE_DOWN;
  if (m === 5) return FACE_UP;
  return FACE_OPPOSITE[HFACE_TO_FACE[(m - 1) & 3]];
}

/** Piston/observer facing helpers. */
function pistonFacing(meta) {
  const f = meta & 7;
  return f > 5 ? FACE_UP : f;
}

// ---------------------------------------------------------------------------
// Per-world state
// ---------------------------------------------------------------------------
const STATE = new WeakMap();

function makeQueue() {
  return { xs: [], ys: [], zs: [], head: 0, set: new Set() };
}

function stateOf(world) {
  let s = STATE.get(world);
  if (!s) {
    s = {
      q: makeQueue(),
      timers: [],
      timerKeys: new Set(),
      processing: false,
      tick: 0,
      pressed: new Map(),      // key -> { x, y, z, id, power, until }
      seen: new Map(),         // scratch reused every entity scan
      watchers: new Map(),     // key -> { x, y, z, kind }
      side: new Map(),         // key -> component scratch state
      stats: { updates: 0, timers: 0 },
    };
    STATE.set(world, s);
  }
  return s;
}

/** Extra per-component state that does not fit in four metadata bits. */
function sideData(world, x, y, z, create = false) {
  const st = stateOf(world);
  const k = posKey(x, y, z);
  let d = st.side.get(k);
  if (!d && create) {
    if (st.side.size > 30000) st.side.clear();   // all of it is recomputable
    d = {};
    st.side.set(k, d);
  }
  return d || null;
}

function dropSideData(world, x, y, z) {
  const st = STATE.get(world);
  if (st) st.side.delete(posKey(x, y, z));
}

// ---- update queue ---------------------------------------------------------

function qPush(q, x, y, z) {
  if (y < 0 || y >= WORLD_HEIGHT) return;
  const k = posKey(x, y, z);
  if (q.set.has(k)) return;
  q.set.add(k);
  q.xs.push(x); q.ys.push(y); q.zs.push(z);
}

const _pos = { x: 0, y: 0, z: 0 };

function qPop(q) {
  if (q.head >= q.xs.length) {
    if (q.head) { q.xs.length = 0; q.ys.length = 0; q.zs.length = 0; q.head = 0; q.set.clear(); }
    return null;
  }
  const i = q.head++;
  _pos.x = q.xs[i]; _pos.y = q.ys[i]; _pos.z = q.zs[i];
  q.set.delete(posKey(_pos.x, _pos.y, _pos.z));
  if (q.head > 2048) {
    q.xs.splice(0, q.head); q.ys.splice(0, q.head); q.zs.splice(0, q.head);
    q.head = 0;
  }
  return _pos;
}

// ---- timers ---------------------------------------------------------------

function timerKey(kind, x, y, z) { return kind + x + ',' + y + ',' + z; }

/**
 * Queues a delayed job. Re-arming the same job while one is pending is a no-op,
 * exactly like vanilla's `scheduleTick` guard, which is what keeps a repeater
 * loop from multiplying itself.
 */
function schedule(world, x, y, z, kind, delay, data = 0) {
  const st = stateOf(world);
  const key = timerKey(kind, x, y, z);
  if (st.timerKeys.has(key)) return false;
  if (st.timers.length > 8192) return false;
  st.timerKeys.add(key);
  st.timers.push({ x, y, z, kind, key, due: st.tick + Math.max(1, delay | 0), data });
  return true;
}

function isScheduled(world, x, y, z, kind) {
  return stateOf(world).timerKeys.has(timerKey(kind, x, y, z));
}

/**
 * Public deferred update: re-examines this block after `delay` ticks.
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z
 * @param {number} delay in game ticks (<= 0 runs on the next drain)
 */
export function scheduleRedstoneUpdate(world, x, y, z, delay = 1) {
  if (!world) return false;
  x = flr(x); y = flr(y); z = flr(z);
  if (y < 0 || y >= WORLD_HEIGHT) return false;
  if (delay <= 0) {
    const st = stateOf(world);
    qPush(st.q, x, y, z);
    if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
    return true;
  }
  return schedule(world, x, y, z, T_UPDATE, delay);
}

// ---------------------------------------------------------------------------
// Signal model
// ---------------------------------------------------------------------------

// While a wire works out its own input, every wire in the world is silenced.
// That single flag is what separates "weak" from "strong" power in practice.
let _muteWire = false;

/**
 * Power the block at (x,y,z) pushes into the neighbour lying in direction
 * `face`, counting only *strong* (direct) output.
 * @returns {number} 0..15
 */
export function strongPower(world, x, y, z, face) {
  return signalOf(world, flr(x), flr(y), flr(z), face | 0, true);
}

/**
 * Power the block at (x,y,z) offers to the neighbour in direction `face`,
 * including its weak output. Strong power is always weak power as well.
 * @returns {number} 0..15
 */
export function weakPower(world, x, y, z, face) {
  return signalOf(world, flr(x), flr(y), flr(z), face | 0, false);
}

function signalOf(world, x, y, z, face, strong) {
  if (!world || y < 0 || y >= WORLD_HEIGHT) return 0;
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  const c = T_COMP[id];
  if (!c) return 0;
  const meta = (v >>> 12) & 15;

  switch (c) {
    case C.WIRE: {
      if (_muteWire) return 0;
      const p = meta & 15;
      if (p === 0) return 0;
      if (face === FACE_UP) return 0;            // dust never powers upward
      if (face === FACE_DOWN) return p;          // ...but always powers its floor
      const h = FACE_TO_HFACE[face];
      return h < 0 ? 0 : (wirePowersSide(world, x, y, z, h) ? p : 0);
    }
    case C.TORCH: {
      if (meta & 8) return 0;                    // off / burnt out
      if (strong) return face === FACE_UP ? 15 : 0;
      return face === mountSupportFace(meta & 7) ? 0 : 15;
    }
    case C.LEVER: {
      if (!(meta & 8)) return 0;
      return strong ? (face === mountSupportFace(meta & 7) ? 15 : 0) : 15;
    }
    case C.BUTTON: {
      if (!(meta & 8)) return 0;
      return strong ? (face === mountSupportFace(meta & 7) ? 15 : 0) : 15;
    }
    case C.HOOK: {
      if (!(meta & 8)) return 0;
      return strong ? (face === mountSupportFace(meta & 7) ? 15 : 0) : 15;
    }
    case C.PLATE: case C.WEIGHTED: {
      const p = meta & 15;
      if (!p) return 0;
      return strong ? (face === FACE_DOWN ? p : 0) : p;
    }
    case C.TRIPWIRE:
      return (meta & 8) && !strong ? 15 : 0;
    case C.REPEATER: {
      if (!(meta & 8)) return 0;
      return face === HFACE_TO_FACE[meta & 3] ? 15 : 0;
    }
    case C.COMPARATOR: {
      if (!(meta & 8)) return 0;
      if (face !== HFACE_TO_FACE[meta & 3]) return 0;
      const d = sideData(world, x, y, z);
      const out = d && d.out !== undefined ? d.out : 15;
      return out;
    }
    case C.OBSERVER: {
      if (!(meta & 4)) return 0;
      return face === FACE_OPPOSITE[HFACE_TO_FACE[meta & 3]] ? 15 : 0;
    }
    case C.RBLOCK:
      return strong ? 0 : 15;
    case C.DAYLIGHT:
      return strong ? 0 : (meta & 15);
    case C.TARGET:
      return strong ? 0 : (meta & 15);
    case C.ROD:
      return (meta & 8) ? 15 : 0;
    case C.SCULK: {
      if (!(meta & 8)) return 0;
      if (strong) return 0;
      const d = sideData(world, x, y, z);
      return d && d.out ? d.out : 15;
    }
    case C.DRAIL: {
      if (!(meta & 8)) return 0;
      return strong ? (face === FACE_DOWN ? 15 : 0) : 15;
    }
    case C.TCHEST: {
      if (strong) return 0;
      const be = safeBlockEntity(world, x, y, z);
      const n = be && be.viewers ? be.viewers | 0 : 0;
      return n > 15 ? 15 : n;
    }
    default:
      return 0;
  }
}

/** What the block at (x,y,z) hands to a neighbour, conductors included. */
function signalFrom(world, x, y, z, face) {
  if (y < 0 || y >= WORLD_HEIGHT) return 0;
  const id = idAt(world, x, y, z);
  if (isCondId(id)) return directSignalTo(world, x, y, z);
  return signalOf(world, x, y, z, face, false);
}

/** Strong power arriving at a conductor from its six neighbours. */
function directSignalTo(world, x, y, z) {
  let p = 0;
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const s = signalOf(world, x + d[0], y + d[1], z + d[2], FACE_OPPOSITE[f], true);
    if (s > p) { p = s; if (p >= 15) return 15; }
  }
  return p;
}

/** Total power a mechanism at this position receives. 0..15. */
function receivedPower(world, x, y, z) {
  let p = 0;
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const s = signalFrom(world, x + d[0], y + d[1], z + d[2], FACE_OPPOSITE[f]);
    if (s > p) { p = s; if (p >= 15) return 15; }
  }
  return p;
}

/**
 * Vanilla's quasi-connectivity: pistons, dispensers and droppers also listen to
 * whatever powers the block directly above them. Players build with this, so it
 * stays.
 */
function receivedPowerQuasi(world, x, y, z, skipFace = -1) {
  for (let f = 0; f < 6; f++) {
    if (f === skipFace) continue;
    const d = FACE_DIRS[f];
    if (signalFrom(world, x + d[0], y + d[1], z + d[2], FACE_OPPOSITE[f]) > 0) return true;
  }
  const ay = y + 1;
  if (ay >= WORLD_HEIGHT) return false;
  for (let f = 0; f < 6; f++) {
    if (f === FACE_DOWN) continue;
    const d = FACE_DIRS[f];
    if (signalFrom(world, x + d[0], ay + d[1], z + d[2], FACE_OPPOSITE[f]) > 0) return true;
  }
  return false;
}

/**
 * Redstone power at a block: a wire reports its own level, a component reports
 * what it outputs, anything else reports what it receives.
 * @returns {number} 0..15
 */
export function getPower(world, x, y, z) {
  if (!world) return 0;
  x = flr(x); y = flr(y); z = flr(z);
  if (y < 0 || y >= WORLD_HEIGHT) return 0;
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  const meta = (v >>> 12) & 15;
  switch (T_COMP[id]) {
    case C.WIRE: return meta & 15;
    case C.RBLOCK: return 15;
    case C.TORCH: return (meta & 8) ? 0 : 15;
    case C.LEVER: case C.BUTTON: case C.HOOK: return (meta & 8) ? 15 : 0;
    case C.PLATE: case C.WEIGHTED: case C.DAYLIGHT: case C.TARGET: return meta & 15;
    case C.TRIPWIRE: case C.DRAIL: case C.ROD: return (meta & 8) ? 15 : 0;
    case C.REPEATER: return (meta & 8) ? 15 : 0;
    case C.COMPARATOR: {
      if (!(meta & 8)) return 0;
      const d = sideData(world, x, y, z);
      return d && d.out !== undefined ? d.out : 15;
    }
    case C.OBSERVER: return (meta & 4) ? 15 : 0;
    case C.SCULK: {
      if (!(meta & 8)) return 0;
      const d = sideData(world, x, y, z);
      return d && d.out ? d.out : 15;
    }
    default: return receivedPower(world, x, y, z);
  }
}

/** True when this block has any redstone signal on it. */
export function isPowered(world, x, y, z) {
  return getPower(world, x, y, z) > 0;
}

// ---------------------------------------------------------------------------
// Dust: connections and network solving
// ---------------------------------------------------------------------------

const isWireAt = (world, x, y, z) => idAt(world, x, y, z) === ID_WIRE;

/** True when dust would draw a line toward this horizontal neighbour. */
function wireConnectsSide(world, x, y, z, h) {
  const nx = x + HDX[h], nz = z + HDZ[h];
  const nid = idAt(world, nx, y, nz);
  if (nid === ID_WIRE) return true;
  if (componentAcceptsWire(world, nx, y, nz, nid, h)) return true;
  if (!isCondId(nid)) {
    if (isWireAt(world, nx, y - 1, nz)) return true;
  } else if (!isCondId(idAt(world, x, y + 1, z))) {
    if (isWireAt(world, nx, y + 1, nz)) return true;
  }
  return false;
}

/** Components dust visibly hooks onto (repeaters only along their axis). */
function componentAcceptsWire(world, x, y, z, id, h) {
  const c = T_COMP[id];
  if (!c) return false;
  switch (c) {
    case C.REPEATER: case C.COMPARATOR: {
      const f = metaAt(world, x, y, z) & 3;
      return f === h || f === ((h + 2) & 3);
    }
    case C.WIRE: case C.TORCH: case C.LEVER: case C.BUTTON: case C.PLATE:
    case C.WEIGHTED: case C.HOOK: case C.RBLOCK: case C.DAYLIGHT: case C.TARGET:
    case C.OBSERVER: case C.SCULK: case C.ROD: case C.DRAIL: case C.TCHEST:
      return true;
    default:
      return false;
  }
}

/** Bit mask of the four horizontal directions this dust points at. */
function wireSideMask(world, x, y, z) {
  let m = 0;
  for (let h = 0; h < 4; h++) if (wireConnectsSide(world, x, y, z, h)) m |= 1 << h;
  return m;
}

/**
 * Whether dust pushes its level into the horizontal direction `h`.
 * A dot (no connections at all) powers all four sides; otherwise the line has
 * to run straight through this block along that axis, which is why a corner
 * never powers the block on its outside.
 */
function wirePowersSide(world, x, y, z, h) {
  const m = wireSideMask(world, x, y, z);
  if (m === 0) return true;
  if (!(m & (1 << ((h + 2) & 3)))) return false;
  return !(m & (1 << ((h + 1) & 3))) && !(m & (1 << ((h + 3) & 3)));
}

// Scratch buffers for the network solve. One network at a time, no allocation.
const _wx = new Int32Array(MAX_WIRE_NODES);
const _wy = new Int32Array(MAX_WIRE_NODES);
const _wz = new Int32Array(MAX_WIRE_NODES);
const _wp = new Uint8Array(MAX_WIRE_NODES);
const _ws = new Uint8Array(MAX_WIRE_NODES);
const _wadj = new Int32Array(MAX_WIRE_NODES * 12);
const _wadjN = new Uint8Array(MAX_WIRE_NODES);
const _windex = new Map();
const _buckets = [];
for (let i = 0; i < 16; i++) _buckets.push([]);
let _wcount = 0;
let _wsolving = false;

function wireNode(x, y, z) {
  const k = posKey(x, y, z);
  const got = _windex.get(k);
  if (got !== undefined) return got;
  if (_wcount >= MAX_WIRE_NODES) return -1;
  const i = _wcount++;
  _wx[i] = x; _wy[i] = y; _wz[i] = z;
  _wadjN[i] = 0;
  _windex.set(k, i);
  return i;
}

/**
 * Links two dust nodes. Edges are kept symmetric: vanilla's slope rule is
 * written from one side only, and a one-way link would leave half a network
 * un-discovered when the solve happens to start at the other end.
 */
function addWireEdge(a, b) {
  if (a < 0 || b < 0 || a === b) return;
  const n = _wadjN[a];
  const base = a * 12;
  for (let k = 0; k < n; k++) if (_wadj[base + k] === b) return;
  if (n >= 12) return;
  _wadj[base + n] = b;
  _wadjN[a] = n + 1;
}

function linkWire(a, b) { addWireEdge(a, b); addWireEdge(b, a); }

/** Every dust reachable from (x,y,z), with adjacency, in the scratch arrays. */
function collectWireNetwork(world, x, y, z) {
  _wcount = 0;
  _windex.clear();
  if (wireNode(x, y, z) < 0) return 0;
  for (let i = 0; i < _wcount; i++) {
    const px = _wx[i], py = _wy[i], pz = _wz[i];
    const aboveCond = isCondId(idAt(world, px, py + 1, pz));
    for (let h = 0; h < 4; h++) {
      const nx = px + HDX[h], nz = pz + HDZ[h];
      const sideId = idAt(world, nx, py, nz);
      if (sideId === ID_WIRE) linkWire(i, wireNode(nx, py, nz));
      if (!isCondId(sideId)) {
        // down a step: only when nothing solid is in the way
        if (isWireAt(world, nx, py - 1, nz)) linkWire(i, wireNode(nx, py - 1, nz));
      } else if (!aboveCond) {
        // up a step: the side block is the stair, and our own roof is open
        if (isWireAt(world, nx, py + 1, nz)) linkWire(i, wireNode(nx, py + 1, nz));
      }
    }
  }
  return _wcount;
}

/** Power a dust node picks up from things that are not dust. */
function wireSourcePower(world, x, y, z) {
  let p = 0;
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const s = signalFrom(world, x + d[0], y + d[1], z + d[2], FACE_OPPOSITE[f]);
    if (s > p) { p = s; if (p >= 15) return 15; }
  }
  return p;
}

/**
 * Solves a whole dust network at once: sources first, then a bucketed
 * relaxation that walks the level down by one per block. Recomputing the
 * component in one shot is what keeps a long wire from flickering through
 * hundreds of partial updates.
 */
function updateWireNetwork(world, x, y, z) {
  if (_wsolving) return;                    // re-entrancy would trash the scratch
  _wsolving = true;
  try {
    const n = collectWireNetwork(world, x, y, z);
    if (n <= 0) return;

    _muteWire = true;
    try {
      for (let i = 0; i < n; i++) _ws[i] = wireSourcePower(world, _wx[i], _wy[i], _wz[i]);
    } finally {
      _muteWire = false;
    }

    for (let i = 0; i < 16; i++) _buckets[i].length = 0;
    for (let i = 0; i < n; i++) {
      _wp[i] = _ws[i];
      if (_ws[i] > 0) _buckets[_ws[i]].push(i);
    }
    for (let p = 15; p >= 1; p--) {
      const b = _buckets[p];
      for (let k = 0; k < b.length; k++) {
        const i = b[k];
        if (_wp[i] !== p) continue;
        const cnt = _wadjN[i];
        const base = i * 12;
        for (let j = 0; j < cnt; j++) {
          const t = _wadj[base + j];
          if (t >= 0 && _wp[t] < p - 1) {
            _wp[t] = p - 1;
            if (p - 1 > 0) _buckets[p - 1].push(t);
          }
        }
      }
    }

    // Write the new levels, then wake everything the changed dust touches.
    const st = stateOf(world);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const cx = _wx[i], cy = _wy[i], cz = _wz[i];
      const v = world.getRaw(cx, cy, cz);
      if ((v & ID_MASK) !== ID_WIRE) continue;
      if (((v >>> 12) & 15) === _wp[i]) continue;
      // flags = 1: light + mesh only. Dust-to-dust updates are already covered
      // by this very solve, so the usual neighbour cascade would be wasted work.
      world.setBlock(cx, cy, cz, ID_WIRE, _wp[i], 1);
      changed++;
      notifyPowerChange(st, world, cx, cy, cz, true);
    }
    if (changed && !st.processing) drain(world, st, IMMEDIATE_BUDGET);
  } catch (e) {
    console.error('[redstone] wire solve failed', e);
  } finally {
    _wsolving = false;
  }
}

// ---------------------------------------------------------------------------
// Update queue plumbing
// ---------------------------------------------------------------------------

/**
 * Wakes the six neighbours of a position and, through any conductor among
 * them, that conductor's own neighbours - the two-deep ring vanilla uses when
 * a power source changes state.
 */
function notifyPowerChange(st, world, x, y, z, skipWire = false) {
  if (!skipWire) qPush(st.q, x, y, z);
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const nx = x + d[0], ny = y + d[1], nz = z + d[2];
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    const nid = idAt(world, nx, ny, nz);
    if (!(skipWire && nid === ID_WIRE)) qPush(st.q, nx, ny, nz);
    if (!isCondId(nid)) continue;
    for (let g = 0; g < 6; g++) {
      if (g === FACE_OPPOSITE[f]) continue;
      const e = FACE_DIRS[g];
      const mx = nx + e[0], my = ny + e[1], mz = nz + e[2];
      if (my < 0 || my >= WORLD_HEIGHT) continue;
      if (skipWire && idAt(world, mx, my, mz) === ID_WIRE) continue;
      qPush(st.q, mx, my, mz);
    }
  }
}

/** Cheap rejection: is there anything redstone-ish next to this position? */
function relevantArea(world, x, y, z) {
  if (T_WATCH[idAt(world, x, y, z)]) return true;
  for (let f = 0; f < 6; f++) {
    const d = FACE_DIRS[f];
    const ny = y + d[1];
    if (ny < 0 || ny >= WORLD_HEIGHT) continue;
    if (T_WATCH[idAt(world, x + d[0], ny, z + d[2])]) return true;
  }
  return false;
}

/**
 * Entry point used by World.setRaw after every block change.
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z
 */
export function updateRedstone(world, x, y, z) {
  if (!world) return;
  x = flr(x); y = flr(y); z = flr(z);
  if (y < 0 || y >= WORLD_HEIGHT) return;
  if (!relevantArea(world, x, y, z)) return;
  const st = stateOf(world);
  notifyPowerChange(st, world, x, y, z);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
}

/** Drains queued updates with a hard cap so nothing can spin forever. */
function drain(world, st, budget) {
  if (st.processing) return 0;
  st.processing = true;
  let n = 0;
  try {
    while (n < budget) {
      const p = qPop(st.q);
      if (!p) break;
      const x = p.x, y = p.y, z = p.z;
      n++;
      try {
        handleUpdate(world, st, x, y, z);
      } catch (e) {
        console.error('[redstone] update failed at', x, y, z, e);
      }
    }
  } finally {
    st.processing = false;
    st.stats.updates += n;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The per-block update
// ---------------------------------------------------------------------------

function handleUpdate(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  const meta = (v >>> 12) & 15;
  const c = T_COMP[id];

  if (!c) {
    dropSideData(world, x, y, z);
    return;
  }

  switch (c) {
    case C.WIRE: updateWireNetwork(world, x, y, z); break;
    case C.REPEATER: updateRepeater(world, st, x, y, z, id, meta); break;
    case C.COMPARATOR:
      // Container contents change without any block update, so comparators get
      // re-read on a slow timer as well as on neighbour changes.
      registerWatcher(st, x, y, z, C.COMPARATOR);
      updateComparator(world, st, x, y, z, id, meta);
      break;
    case C.TORCH: updateTorch(world, st, x, y, z, id, meta); break;
    case C.LAMP: updateLamp(world, st, x, y, z, id, meta); break;
    case C.DOOR: updateDoor(world, st, x, y, z, id, meta); break;
    case C.TRAPDOOR: case C.GATE: updateFlap(world, st, x, y, z, id, meta, c); break;
    case C.PISTON: updatePiston(world, st, x, y, z, id, meta); break;
    case C.HEAD: updatePistonHead(world, st, x, y, z, id, meta); break;
    case C.OBSERVER: updateObserver(world, st, x, y, z, id, meta); break;
    case C.DISPENSER: updateDispenser(world, st, x, y, z, id, meta); break;
    case C.TNT: updateTnt(world, st, x, y, z, id, meta); break;
    case C.NOTE: updateNoteBlock(world, st, x, y, z, id, meta); break;
    case C.HOPPER: updateHopper(world, st, x, y, z, id, meta); break;
    case C.BELL: updateBell(world, st, x, y, z, id, meta); break;
    case C.RAIL: case C.PRAIL: case C.DRAIL: case C.ARAIL:
      updateRail(world, st, x, y, z, id, meta, c); break;
    case C.HOOK: updateTripwireHook(world, st, x, y, z, id, meta); break;
    case C.DAYLIGHT: registerWatcher(st, x, y, z, C.DAYLIGHT); updateDaylight(world, st, x, y, z, id, meta); break;
    case C.SCULK: registerWatcher(st, x, y, z, C.SCULK); break;
    case C.PLATE: case C.WEIGHTED: case C.TRIPWIRE: break;   // driven by entities
    case C.BUTTON:
      // Whoever pressed it - this module or blockupdate.js - it has to pop out.
      if ((meta & 8) && !isScheduled(world, x, y, z, T_BUTTON_T)) {
        schedule(world, x, y, z, T_BUTTON_T, getBlock(id).sound === 'wood' ? 30 : 20);
      }
      break;
    case C.TARGET:
      if ((meta & 15) && !isScheduled(world, x, y, z, T_DECAY)) {
        schedule(world, x, y, z, T_DECAY, 20);
      }
      break;
    case C.ROD:
      if ((meta & 8) && !isScheduled(world, x, y, z, T_DECAY)) {
        schedule(world, x, y, z, T_DECAY, 8);
      }
      break;
    case C.LEVER: case C.RBLOCK: case C.TCHEST: case C.MOVING: break;   // pure sources
    default: break;
  }
}

// ---- repeater -------------------------------------------------------------

/** Repeater delay in redstone ticks, 1..4 (two game ticks each). */
function repeaterDelay(world, x, y, z) {
  const d = sideData(world, x, y, z);
  const n = d && d.delay ? d.delay | 0 : 1;
  return n < 1 ? 1 : n > 4 ? 4 : n;
}

/**
 * What a diode reads out of the block feeding it. Dust is read straight off the
 * block instead of through `getSignal`, exactly like vanilla, so a wire running
 * sideways into a repeater still drives it.
 */
function diodeInput(world, x, y, z, face) {
  const d = FACE_DIRS[face];
  const bx = x + d[0], by = y + d[1], bz = z + d[2];
  let i = signalFrom(world, bx, by, bz, FACE_OPPOSITE[face]);
  if (i >= 15) return 15;
  if (idAt(world, bx, by, bz) === ID_WIRE) {
    const p = metaAt(world, bx, by, bz) & 15;
    if (p > i) i = p;
  }
  return i;
}

function repeaterInput(world, x, y, z, meta) {
  const outFace = HFACE_TO_FACE[meta & 3];
  return diodeInput(world, x, y, z, FACE_OPPOSITE[outFace]) > 0;
}

/** A powered repeater or comparator aimed at our flank freezes us. */
function diodeLocked(world, x, y, z, meta) {
  const hf = meta & 3;
  for (let k = 0; k < 2; k++) {
    const side = k === 0 ? (hf + 1) & 3 : (hf + 3) & 3;
    const nx = x + HDX[side], nz = z + HDZ[side];
    const nv = world.getRaw(nx, y, nz);
    const nid = nv & ID_MASK;
    const nm = (nv >>> 12) & 15;
    const nc = T_COMP[nid];
    if ((nc === C.REPEATER || nc === C.COMPARATOR) && (nm & 8) && (nm & 3) === ((side + 2) & 3)) {
      return true;
    }
  }
  return false;
}

function updateRepeater(world, st, x, y, z, id, meta) {
  // A locked repeater keeps whatever it was showing until the lock lifts.
  if (diodeLocked(world, x, y, z, meta)) return;
  const input = repeaterInput(world, x, y, z, meta);
  const powered = (meta & 8) !== 0;
  if (input !== powered) schedule(world, x, y, z, T_DIODE, repeaterDelay(world, x, y, z) * 2);
}

function fireRepeater(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.REPEATER) return;
  const meta = (v >>> 12) & 15;
  if (diodeLocked(world, x, y, z, meta)) return;
  const input = repeaterInput(world, x, y, z, meta);
  const powered = (meta & 8) !== 0;
  if (input === powered) return;
  setMeta(world, x, y, z, id, input ? (meta | 8) : (meta & ~8), 1);
  notifyOutput(st, world, x, y, z, HFACE_TO_FACE[meta & 3]);
}

// ---- comparator -----------------------------------------------------------

function comparatorSideInput(world, x, y, z, side) {
  const nx = x + HDX[side], nz = z + HDZ[side];
  const nv = world.getRaw(nx, y, nz);
  const nid = nv & ID_MASK;
  const nm = (nv >>> 12) & 15;
  const c = T_COMP[nid];
  if (c === C.WIRE) return nm & 15;
  if (c === C.RBLOCK) return 15;
  if ((c === C.REPEATER || c === C.COMPARATOR) && (nm & 3) === ((side + 2) & 3)) {
    return signalOf(world, nx, y, nz, HFACE_TO_FACE[nm & 3], false);
  }
  return 0;
}

function comparatorOutput(world, x, y, z, meta) {
  const outFace = HFACE_TO_FACE[meta & 3];
  const backFace = FACE_OPPOSITE[outFace];
  const backDir = FACE_DIRS[backFace];
  const bx = x + backDir[0], by = y + backDir[1], bz = z + backDir[2];
  let input = diodeInput(world, x, y, z, backFace);
  const container = comparatorSignal(world, bx, by, bz);
  if (container > input) input = container;
  const hf = meta & 3;
  const sides = Math.max(
    comparatorSideInput(world, x, y, z, (hf + 1) & 3),
    comparatorSideInput(world, x, y, z, (hf + 3) & 3),
  );
  if (meta & 4) return Math.max(0, input - sides);       // subtract mode
  return sides > input ? 0 : input;                      // compare mode
}

function updateComparator(world, st, x, y, z, id, meta) {
  const want = comparatorOutput(world, x, y, z, meta);
  const d = sideData(world, x, y, z, true);
  const have = (meta & 8) ? (d.out !== undefined ? d.out : 15) : 0;
  if (want !== have) schedule(world, x, y, z, T_DIODE, 2);
}

function fireComparator(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.COMPARATOR) return;
  const meta = (v >>> 12) & 15;
  const want = comparatorOutput(world, x, y, z, meta);
  const d = sideData(world, x, y, z, true);
  const have = (meta & 8) ? (d.out !== undefined ? d.out : 15) : 0;
  if (want === have) return;
  d.out = want;
  setMeta(world, x, y, z, id, want > 0 ? (meta | 8) : (meta & ~8), 1);
  notifyOutput(st, world, x, y, z, HFACE_TO_FACE[meta & 3]);
}

/** Wakes the block a diode feeds plus the usual ring around ourselves. */
function notifyOutput(st, world, x, y, z, face) {
  notifyPowerChange(st, world, x, y, z);
  const d = FACE_DIRS[face] || FACE_DIRS[FACE_NORTH];
  notifyPowerChange(st, world, x + d[0], y + d[1], z + d[2]);
}

// ---- redstone torch -------------------------------------------------------

function torchSupportPowered(world, x, y, z, meta) {
  const face = mountSupportFace(meta & 7);
  const d = FACE_DIRS[face];
  return signalFrom(world, x + d[0], y + d[1], z + d[2], FACE_OPPOSITE[face]) > 0;
}

function updateTorch(world, st, x, y, z, id, meta) {
  const powered = torchSupportPowered(world, x, y, z, meta);
  const off = (meta & 8) !== 0;
  if (powered === off) return;               // already agrees with its support
  schedule(world, x, y, z, T_TORCH_T, 2);
}

function fireTorch(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.TORCH) return;
  const meta = (v >>> 12) & 15;
  const powered = torchSupportPowered(world, x, y, z, meta);
  const off = (meta & 8) !== 0;
  const d = sideData(world, x, y, z, true);
  if (d.burnUntil && st.tick < d.burnUntil) {
    if (!off) { setMeta(world, x, y, z, id, meta | 8, 1); notifyPowerChange(st, world, x, y, z); }
    schedule(world, x, y, z, T_TORCH_T, d.burnUntil - st.tick + 1);
    return;
  }
  if (powered === off) return;

  // Burnout: too many flips in a short window and the torch gives up for a bit.
  if (!d.flips || st.tick - (d.flipStart || 0) > TORCH_BURN_WINDOW) {
    d.flips = 0;
    d.flipStart = st.tick;
  }
  d.flips++;
  if (d.flips > TORCH_BURN_LIMIT) {
    d.burnUntil = st.tick + TORCH_BURN_TIME;
    d.flips = 0;
    d.flipStart = st.tick;
    if (!off) {
      setMeta(world, x, y, z, id, meta | 8, 1);
      notifyPowerChange(st, world, x, y, z);
    }
    playAt('redstone_torch_burnout', x + 0.5, y + 0.5, z + 0.5, 0.5, 2.6);
    particles('smoke', x + 0.5, y + 0.6, z + 0.5, { count: 5, spread: 0.15, life: 0.8 });
    schedule(world, x, y, z, T_TORCH_T, TORCH_BURN_TIME + 1);
    return;
  }

  setMeta(world, x, y, z, id, powered ? (meta | 8) : (meta & ~8), 1);
  notifyPowerChange(st, world, x, y, z);
  // The torch strongly powers the block above it, so that whole ring matters.
  notifyPowerChange(st, world, x, y + 1, z);
}

// ---- lamp -----------------------------------------------------------------

function updateLamp(world, st, x, y, z, id, meta) {
  const powered = receivedPower(world, x, y, z) > 0;
  const lit = (meta & 1) !== 0;
  if (powered && !lit) {
    setMeta(world, x, y, z, id, meta | 1, 3);
  } else if (!powered && lit) {
    schedule(world, x, y, z, T_LAMP_T, 4);
  }
}

function fireLamp(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.LAMP) return;
  const meta = (v >>> 12) & 15;
  if ((meta & 1) && receivedPower(world, x, y, z) === 0) {
    setMeta(world, x, y, z, id, meta & ~1, 3);
  }
}

// ---- doors, trapdoors, gates ---------------------------------------------

function updateDoor(world, st, x, y, z, id, meta) {
  const upper = (meta & 1) !== 0;
  const baseY = upper ? y - 1 : y;
  if (idAt(world, x, baseY, z) !== id || idAt(world, x, baseY + 1, z) !== id) return;
  const powered = receivedPower(world, x, baseY, z) > 0 || receivedPower(world, x, baseY + 1, z) > 0;
  const lowMeta = metaAt(world, x, baseY, z);
  const open = (lowMeta & 8) !== 0;
  if (powered === open) return;
  for (let i = 0; i < 2; i++) {
    const yy = baseY + i;
    const m = metaAt(world, x, yy, z);
    setMeta(world, x, yy, z, id, powered ? (m | 8) : (m & ~8), 3);
  }
  const iron = getBlock(id).name.indexOf('iron') === 0;
  playAt(powered ? (iron ? 'iron_door_open' : 'door_open') : (iron ? 'iron_door_close' : 'door_close'),
    x + 0.5, baseY + 0.5, z + 0.5, 0.9, 1);
}

function updateFlap(world, st, x, y, z, id, meta, kind) {
  const powered = receivedPower(world, x, y, z) > 0;
  const open = (meta & 4) !== 0;
  if (powered === open) return;
  setMeta(world, x, y, z, id, powered ? (meta | 4) : (meta & ~4), 3);
  const iron = getBlock(id).name.indexOf('iron') === 0;
  playAt(powered ? (iron ? 'iron_door_open' : 'door_open') : (iron ? 'iron_door_close' : 'door_close'),
    x + 0.5, y + 0.5, z + 0.5, 0.8, kind === C.GATE ? 0.95 : 1.1);
}

// ---- hopper, bell, tnt, note block ---------------------------------------

function updateHopper(world, st, x, y, z, id, meta) {
  const powered = receivedPower(world, x, y, z) > 0;
  const locked = (meta & 8) !== 0;
  if (powered === locked) return;
  setMeta(world, x, y, z, id, powered ? (meta | 8) : (meta & ~8), 1);
  const be = safeBlockEntity(world, x, y, z);
  if (be) be.locked = powered;
}

function updateBell(world, st, x, y, z, id, meta) {
  const powered = receivedPower(world, x, y, z) > 0;
  const was = (meta & 8) !== 0;
  if (powered === was) return;
  setMeta(world, x, y, z, id, powered ? (meta | 8) : (meta & ~8), 1);
  if (powered) playAt('bell_use', x + 0.5, y + 0.5, z + 0.5, 1, 1);
}

function updateTnt(world, st, x, y, z, id, meta) {
  if (receivedPower(world, x, y, z) === 0) return;
  igniteTnt(world, x, y, z, null);
}

/** Turns a TNT block into a primed entity. Safe when itementity.js is missing. */
function igniteTnt(world, x, y, z, igniter) {
  if (idAt(world, x, y, z) !== ID_TNT) return false;
  world.setBlock(x, y, z, ID_AIR, 0, 3);
  let ok = false;
  if (_itementity && typeof _itementity.primeTNT === 'function') {
    try { ok = !!_itementity.primeTNT(world, x, y, z, 80, igniter); } catch { ok = false; }
  }
  if (!ok) {
    // No entity module: fall back to a straight explosion so the block still does
    // something recognisable instead of silently vanishing.
    try {
      import('../entity/combat.js').then((m) => {
        if (m && typeof m.explode === 'function') m.explode(world, x + 0.5, y + 0.5, z + 0.5, 4, { fire: false, breakBlocks: true });
      }).catch(() => { /* optional */ });
    } catch { /* optional */ }
  }
  playAt('tnt_prime', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  return true;
}

const NOTE_SOUND_BY_GROUP = {
  stone: 'note_basedrum', metal: 'note_basedrum', anvil: 'note_basedrum',
  sand: 'note_snare', gravel: 'note_snare', snow: 'note_snare',
  glass: 'note_hat', wool: 'note_hat', slime: 'note_hat',
  wood: 'note_basedrum', grass: 'note_hat', ladder: 'note_hat', nether_wart: 'note_hat',
};

function updateNoteBlock(world, st, x, y, z, id, meta) {
  const powered = receivedPower(world, x, y, z) > 0;
  const was = (meta & 8) !== 0;
  if (powered === was) return;
  setMeta(world, x, y, z, id, powered ? (meta | 8) : (meta & ~8), 1);
  if (powered) playNote(world, x, y, z);
}

/** Plays the note block's current note, picking the timbre from the block below. */
export function playNote(world, x, y, z) {
  if (idAt(world, x, y, z) !== ID_NOTE_BLOCK) return false;
  if (idAt(world, x, y + 1, z) !== ID_AIR) return false;    // needs air above, like vanilla
  const be = safeBlockEntity(world, x, y, z);
  let note = be && be.note !== undefined ? be.note | 0 : 0;
  note = note < 0 ? 0 : note > 24 ? 24 : note;
  const below = getBlock(idAt(world, x, y - 1, z));
  const sound = NOTE_SOUND_BY_GROUP[below.sound] || 'note_basedrum';
  // Two octaves, F#3 to F#5, centred on the middle of the range like vanilla.
  const pitch = Math.pow(2, (note - 12) / 12);
  playAt(sound, x + 0.5, y + 0.5, z + 0.5, 0.9, pitch);
  particles('note', x + 0.5, y + 1.2, z + 0.5, { count: 1 });
  return true;
}

// ---- observer -------------------------------------------------------------

function updateObserver(world, st, x, y, z, id, meta) {
  const face = HFACE_TO_FACE[meta & 3];
  const d = FACE_DIRS[face];
  const tx = x + d[0], ty = y + d[1], tz = z + d[2];
  const cur = (ty < 0 || ty >= WORLD_HEIGHT) ? 0 : world.getRaw(tx, ty, tz);
  const s = sideData(world, x, y, z, true);
  if (s.watch === undefined) { s.watch = cur; return; }
  if (s.watch === cur) return;
  s.watch = cur;
  if (meta & 4) return;                       // already pulsing
  setMeta(world, x, y, z, id, meta | 4, 1);
  schedule(world, x, y, z, T_OBSERVER, 2);
  notifyObserverOutput(st, world, x, y, z, meta);
}

function notifyObserverOutput(st, world, x, y, z, meta) {
  const back = FACE_OPPOSITE[HFACE_TO_FACE[meta & 3]];
  const d = FACE_DIRS[back];
  notifyPowerChange(st, world, x, y, z);
  notifyPowerChange(st, world, x + d[0], y + d[1], z + d[2]);
}

function fireObserver(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.OBSERVER) return;
  const meta = (v >>> 12) & 15;
  if (!(meta & 4)) return;
  setMeta(world, x, y, z, id, meta & ~4, 1);
  notifyObserverOutput(st, world, x, y, z, meta);
}

// ---- dispenser / dropper --------------------------------------------------

function updateDispenser(world, st, x, y, z, id, meta) {
  const powered = receivedPowerQuasi(world, x, y, z);
  const trig = (meta & 4) !== 0;
  if (powered === trig) return;
  setMeta(world, x, y, z, id, powered ? (meta | 4) : (meta & ~4), 1);
  if (powered) schedule(world, x, y, z, T_DISPENSE, 4);
}

/** Uniform view over the many shapes a container block entity can take. */
function containerView(be) {
  if (!be) return null;
  const inv = be.inventory || be.container;
  if (inv && typeof inv.get === 'function' && typeof inv.set === 'function') {
    const size = inv.size !== undefined ? inv.size : (inv.slots ? inv.slots.length : 0);
    return {
      size,
      get: (i) => inv.get(i),
      set: (i, s) => inv.set(i, s),
    };
  }
  const arr = Array.isArray(be.items) ? be.items : (Array.isArray(inv) ? inv : null);
  if (arr) {
    return {
      size: arr.length,
      get: (i) => arr[i] || null,
      set: (i, s) => { arr[i] = s; },
    };
  }
  return null;
}

const emptyStack = (s) => !s || !s.item || (s.count | 0) <= 0;

const PROJECTILE_ITEMS = {
  arrow: 'arrow', spectral_arrow: 'spectral_arrow', tipped_arrow: 'tipped_arrow',
  snowball: 'snowball', egg: 'egg', ender_pearl: 'ender_pearl',
  splash_potion: 'splash_potion', lingering_potion: 'lingering_potion',
  fire_charge: 'small_fireball', firework_rocket: 'firework_rocket',
  experience_bottle: 'experience_bottle',
};

function fireDispenser(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.DISPENSER) return;
  const meta = (v >>> 12) & 15;
  const be = safeBlockEntity(world, x, y, z);
  const view = containerView(be);
  const isDropper = id === ID_DROPPER;
  const hf = meta & 3;
  const dx = HDX[hf], dz = HDZ[hf];
  const fx = x + dx, fy = y, fz = z + dz;

  let slot = -1;
  if (view) {
    for (let i = 0; i < view.size; i++) {
      if (!emptyStack(view.get(i))) { slot = i; break; }
    }
  }
  if (slot < 0) {
    playAt('click', x + 0.5, y + 0.5, z + 0.5, 0.7, 1.2);
    return;
  }

  const src = view.get(slot);
  const one = { item: src.item, count: 1, damage: src.damage || 0 };
  if (src.nbt) one.nbt = src.nbt;
  src.count -= 1;
  view.set(slot, src.count > 0 ? src : null);

  // A dropper facing a container posts its item into it instead of throwing it.
  if (isDropper && insertInto(world, fx, fy, fz, one)) {
    playAt('click', x + 0.5, y + 0.5, z + 0.5, 0.6, 1.1);
    return;
  }

  const cx = x + 0.5 + dx * 0.7, cy = y + 0.5, cz = z + 0.5 + dz * 0.7;
  const proj = !isDropper ? PROJECTILE_ITEMS[one.item] : null;
  if (proj && _projectiles && typeof _projectiles.spawnProjectile === 'function') {
    try {
      _projectiles.spawnProjectile(proj, world, null, cx, cy, cz, dx, 0.06, dz, { stack: one, power: 1.1 });
    } catch { /* projectile module still loading */ }
  } else if (!isDropper && one.item === 'tnt') {
    if (_itementity && typeof _itementity.primeTNT === 'function') {
      try { _itementity.primeTNT(world, fx, fy, fz, 80, null); } catch { /* optional */ }
    }
  } else if (!isDropper && (one.item === 'flint_and_steel' || one.item === 'fire_charge')) {
    igniteInFront(world, fx, fy, fz);
  } else {
    dropStackAt(world, cx, cy, cz, one, dx * 0.22, 0.08, dz * 0.22);
  }
  playAt(isDropper ? 'click' : 'dispenser_fire', x + 0.5, y + 0.5, z + 0.5, 1, 1);
  particles('smoke', cx, cy, cz, { count: 4, spread: 0.2, vx: dx * 0.4, vz: dz * 0.4 });
}

function igniteInFront(world, x, y, z) {
  const fire = blockByName('fire');
  if (!fire) return;
  if (idAt(world, x, y, z) !== ID_AIR) return;
  world.setBlock(x, y, z, fire.id, 0, 3);
  playAt('flint_and_steel', x + 0.5, y + 0.5, z + 0.5, 1, 1);
}

/** Pushes one item into a container in the world. Returns true when it fit. */
function insertInto(world, x, y, z, one) {
  const be = safeBlockEntity(world, x, y, z);
  const view = containerView(be);
  if (!view || view.size <= 0) return false;
  let max = 64;
  if (_inventory && typeof _inventory.maxStackSize === 'function') {
    try { max = _inventory.maxStackSize(one); } catch { max = 64; }
  }
  for (let i = 0; i < view.size; i++) {
    const s = view.get(i);
    if (!emptyStack(s) && s.item === one.item && (s.count | 0) < max) {
      s.count = (s.count | 0) + 1;
      view.set(i, s);
      return true;
    }
  }
  for (let i = 0; i < view.size; i++) {
    if (emptyStack(view.get(i))) { view.set(i, one); return true; }
  }
  return false;
}

function dropStackAt(world, x, y, z, stack, vx, vy, vz) {
  if (_itementity && typeof _itementity.dropItem === 'function') {
    try { _itementity.dropItem(world, x, y, z, stack, vx, vy, vz); return true; } catch { /* optional */ }
  }
  return false;
}

// ---- pistons --------------------------------------------------------------

function updatePiston(world, st, x, y, z, id, meta) {
  const facing = pistonFacing(meta);
  const extended = (meta & 8) !== 0;
  // Self-heal a piston whose head was mined away (never mid-stroke, when the
  // head and the base legitimately disagree for a moment).
  const d = FACE_DIRS[facing];
  if (!_pistonBusy && extended && T_COMP[idAt(world, x + d[0], y + d[1], z + d[2])] !== C.HEAD) {
    setMeta(world, x, y, z, id, meta & ~8, 3);
    return;
  }
  const powered = receivedPowerQuasi(world, x, y, z, facing);
  if (powered === extended) return;
  schedule(world, x, y, z, T_PISTON_T, 1, powered ? 1 : 0);
}

function updatePistonHead(world, st, x, y, z, id, meta) {
  if (_pistonBusy) return;
  const facing = pistonFacing(meta);
  const d = FACE_DIRS[FACE_OPPOSITE[facing]];
  const bx = x + d[0], by = y + d[1], bz = z + d[2];
  const bid = idAt(world, bx, by, bz);
  if (T_COMP[bid] !== C.PISTON || !(metaAt(world, bx, by, bz) & 8)) {
    world.setBlock(x, y, z, ID_AIR, 0, 3);      // orphaned head
  }
}

function firePiston(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.PISTON) return;
  const meta = (v >>> 12) & 15;
  // Recompute rather than trusting the state the timer was armed with: the
  // signal may well have flipped again during the delay.
  const powered = receivedPowerQuasi(world, x, y, z, pistonFacing(meta));
  try {
    tryMovePiston(world, x, y, z, powered);
  } catch (e) {
    console.error('[redstone] piston move failed', e);
  }
}

/** Non-zero while a stroke is half-applied, so the self-heal checks hold off. */
let _pistonBusy = 0;

const isDestroyedByPiston = (id) => T_PUSH[id] === 2;

function canPushBlock(world, x, y, z, id) {
  if (id === ID_AIR) return true;
  if (T_PUSH[id] === 1) return false;
  const c = T_COMP[id];
  if (c === C.HEAD || c === C.MOVING) return false;
  if (c === C.PISTON && (metaAt(world, x, y, z) & 8)) return false;
  if (getBlock(id).entityType) return false;
  if (safeBlockEntity(world, x, y, z)) return false;
  return true;
}

/** Slime sticks to everything except honey, and vice versa. */
function adheres(a, b) {
  if (!a) return false;
  if (b && b !== a) return false;
  return true;
}

const _pushList = [];
const _destroyList = [];
const _pushSeen = new Set();
const _pushStack = [];

/**
 * Works out everything one piston stroke would move.
 * @returns {boolean} false when the stroke is blocked
 */
function collectPistonBlocks(world, sx, sy, sz, dir, px, py, pz) {
  const dv = FACE_DIRS[dir];
  _pushList.length = 0;
  _destroyList.length = 0;
  _pushSeen.clear();
  _pushStack.length = 0;
  _pushStack.push(sx, sy, sz, 0);

  while (_pushStack.length) {
    const branch = _pushStack.pop();
    const bz = _pushStack.pop();
    const by = _pushStack.pop();
    const bx = _pushStack.pop();
    if (by < 0 || by >= WORLD_HEIGHT) return false;
    const k = posKey(bx, by, bz);
    if (_pushSeen.has(k)) continue;
    const id = idAt(world, bx, by, bz);
    if (id === ID_AIR) continue;
    if (isDestroyedByPiston(id)) {
      if (branch) continue;                    // slime never drags loose bits
      _pushSeen.add(k);
      _destroyList.push(bx, by, bz);
      continue;
    }
    if (bx === px && by === py && bz === pz) return false;
    if (!canPushBlock(world, bx, by, bz, id)) return false;
    _pushSeen.add(k);
    _pushList.push(bx, by, bz);
    if (_pushList.length / 3 > MAX_PUSH) return false;

    _pushStack.push(bx + dv[0], by + dv[1], bz + dv[2], 0);
    const sticky = T_STICKY[id];
    if (sticky) {
      for (let f = 0; f < 6; f++) {
        const e = FACE_DIRS[f];
        const nx = bx + e[0], ny = by + e[1], nz = bz + e[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (nx === px && ny === py && nz === pz) continue;   // never drag the piston itself
        const nid = idAt(world, nx, ny, nz);
        if (nid === ID_AIR) continue;
        if (!adheres(sticky, T_STICKY[nid])) continue;
        _pushStack.push(nx, ny, nz, 1);
      }
    }
  }

  // Every destination must end up free.
  for (let i = 0; i < _pushList.length; i += 3) {
    const tx = _pushList[i] + dv[0], ty = _pushList[i + 1] + dv[1], tz = _pushList[i + 2] + dv[2];
    if (ty < 0 || ty >= WORLD_HEIGHT) return false;
    if (_pushSeen.has(posKey(tx, ty, tz))) continue;
    const tid = idAt(world, tx, ty, tz);
    if (tid === ID_AIR || isDestroyedByPiston(tid)) continue;
    return false;
  }
  return true;
}

const _moveVals = [];

/** Slides a collected group one block along (dx,dy,dz). */
function moveCollected(world, list, dx, dy, dz) {
  _moveVals.length = 0;
  for (let i = 0; i < list.length; i += 3) {
    _moveVals.push(world.getRaw(list[i], list[i + 1], list[i + 2]));
  }
  for (let i = 0; i < list.length; i += 3) {
    world.setBlock(list[i], list[i + 1], list[i + 2], ID_AIR, 0, 1);
  }
  for (let i = 0, j = 0; i < list.length; i += 3, j++) {
    world.setRaw(list[i] + dx, list[i + 1] + dy, list[i + 2] + dz, _moveVals[j], 3);
  }
}

/** Breaks a block the piston shoves into, dropping whatever it would drop. */
function breakForPiston(world, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (id === ID_AIR) return;
  const meta = (v >>> 12) & 15;
  const def = getBlock(id);
  if (!def.liquid && _loot && typeof _loot.blockDrops === 'function') {
    try {
      const drops = _loot.blockDrops(world, x, y, z, id, meta, null, null);
      if (drops && drops.length && _itementity && typeof _itementity.dropStacks === 'function') {
        _itementity.dropStacks(world, x + 0.5, y + 0.5, z + 0.5, drops);
      }
    } catch { /* loot table still loading */ }
  }
  world.setBlock(x, y, z, ID_AIR, 0, 3);
  particles('block', x + 0.5, y + 0.5, z + 0.5, { count: 8, block: id });
}

/**
 * Extends or retracts a piston, moving up to 12 blocks, dragging slime/honey
 * neighbours along and refusing anything immovable.
 * @param {object} world
 * @param {number} x @param {number} y @param {number} z piston position
 * @param {boolean} extend true to push out, false to pull back
 * @returns {boolean} whether the piston actually moved
 */
export function tryMovePiston(world, x, y, z, extend) {
  if (!world) return false;
  _pistonBusy++;
  let moved = false;
  try {
    moved = doMovePiston(world, flr(x), flr(y), flr(z), !!extend);
  } finally {
    _pistonBusy--;
  }
  if (moved) {
    const st = stateOf(world);
    if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  }
  return moved;
}

function doMovePiston(world, x, y, z, extend) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.PISTON) return false;
  const meta = (v >>> 12) & 15;
  const facing = pistonFacing(meta);
  const extended = (meta & 8) !== 0;
  if (!!extend === extended) return false;

  const d = FACE_DIRS[facing];
  const hx = x + d[0], hy = y + d[1], hz = z + d[2];
  if (hy < 0 || hy >= WORLD_HEIGHT) return false;
  const st = stateOf(world);
  const sticky = id === ID_STICKY_PISTON;

  if (extend) {
    if (!collectPistonBlocks(world, hx, hy, hz, facing, x, y, z)) return false;
    for (let i = _destroyList.length - 3; i >= 0; i -= 3) {
      breakForPiston(world, _destroyList[i], _destroyList[i + 1], _destroyList[i + 2]);
    }
    if (_pushList.length) moveCollected(world, _pushList, d[0], d[1], d[2]);
    world.setBlock(x, y, z, id, facing | 8, 1);
    world.setBlock(hx, hy, hz, ID_PISTON_HEAD, facing | (sticky ? 8 : 0), 1);
    playAt('piston_extend', x + 0.5, y + 0.5, z + 0.5, 0.6, 0.85);
    notifyPowerChange(st, world, x, y, z);
    notifyPowerChange(st, world, hx, hy, hz);
    return true;
  }

  // Retract: pull the head in first so the pulled block has somewhere to land.
  if (T_COMP[idAt(world, hx, hy, hz)] === C.HEAD) {
    world.setBlock(hx, hy, hz, ID_AIR, 0, 1);
  }
  world.setBlock(x, y, z, id, facing, 1);

  if (sticky) {
    const px = hx + d[0], py = hy + d[1], pz = hz + d[2];
    if (py >= 0 && py < WORLD_HEIGHT) {
      const pid = idAt(world, px, py, pz);
      if (pid !== ID_AIR && !isDestroyedByPiston(pid) && canPushBlock(world, px, py, pz, pid)) {
        const back = FACE_OPPOSITE[facing];
        if (collectPistonBlocks(world, px, py, pz, back, x, y, z)) {
          const bd = FACE_DIRS[back];
          if (_pushList.length) moveCollected(world, _pushList, bd[0], bd[1], bd[2]);
        }
      }
    }
  }
  playAt('piston_retract', x + 0.5, y + 0.5, z + 0.5, 0.6, 0.75);
  notifyPowerChange(st, world, x, y, z);
  notifyPowerChange(st, world, hx, hy, hz);
  return true;
}

// ---------------------------------------------------------------------------
// Rails
// ---------------------------------------------------------------------------

// Shape numbering matches vehicles.js: 0 north-south, 1 east-west,
// 2..5 ascending east/west/north/south, 6..9 the south-east/south-west/
// north-west/north-east corners.
const isRailId = (id) => {
  const c = T_COMP[id];
  return c === C.RAIL || c === C.PRAIL || c === C.DRAIL || c === C.ARAIL;
};

function railShapeOf(id, meta) {
  if (T_COMP[id] === C.RAIL) {
    const s = meta & 15;
    return s > 9 ? 0 : s;
  }
  const s = meta & 7;
  return s > 5 ? 0 : s;
}

/** Is there a rail at (x, y±1, z) we should link to? Returns its rise. */
function railNeighbourRise(world, x, y, z) {
  if (isRailId(idAt(world, x, y, z))) return 0;
  if (isRailId(idAt(world, x, y + 1, z))) return 1;
  if (isRailId(idAt(world, x, y - 1, z))) return -1;
  return null;
}

/**
 * Re-derives a rail's shape from its neighbours, the way a track snaps into
 * place when you build next to it.
 */
export function updateRailShape(world, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (!isRailId(id)) return false;
  const meta = (v >>> 12) & 15;
  const curved = T_COMP[id] === C.RAIL;

  // Which of the four horizontal directions has a rail we can join?
  const link = [null, null, null, null];
  let count = 0;
  for (let h = 0; h < 4; h++) {
    const rise = railNeighbourRise(world, x + HDX[h], y, z + HDZ[h]);
    if (rise !== null) { link[h] = rise; count++; }
  }

  const N = 0, E = 1, S = 2, W = 3;
  let shape = railShapeOf(id, meta);
  const has = (h) => link[h] !== null;

  if (count === 0) {
    // Leave the existing straight orientation alone.
    shape = (shape === 1 || shape === 2 || shape === 3) ? 1 : (shape > 5 ? 0 : shape);
  } else if (count === 1) {
    const h = has(N) ? N : has(S) ? S : has(E) ? E : W;
    const rise = link[h];
    if (h === N) shape = rise > 0 ? 4 : 0;
    else if (h === S) shape = rise > 0 ? 5 : 0;
    else if (h === E) shape = rise > 0 ? 2 : 1;
    else shape = rise > 0 ? 3 : 1;
  } else {
    // Prefer straight lines, then corners (plain rails only).
    if (has(N) && has(S)) shape = link[N] > 0 ? 4 : link[S] > 0 ? 5 : 0;
    else if (has(E) && has(W)) shape = link[E] > 0 ? 2 : link[W] > 0 ? 3 : 1;
    else if (curved) {
      if (has(S) && has(E)) shape = 6;
      else if (has(S) && has(W)) shape = 7;
      else if (has(N) && has(W)) shape = 8;
      else shape = 9;
    } else if (has(N) || has(S)) {
      shape = has(N) && link[N] > 0 ? 4 : has(S) && link[S] > 0 ? 5 : 0;
    } else {
      shape = has(E) && link[E] > 0 ? 2 : has(W) && link[W] > 0 ? 3 : 1;
    }
  }

  if (shape === railShapeOf(id, meta)) return false;
  const keep = curved ? 0 : (meta & 8);
  return setMeta(world, x, y, z, id, (shape & (curved ? 15 : 7)) | keep, 3);
}

/** Follows the track looking for a powered rail feeding this one. */
function railChainPowered(world, x, y, z, dirIndex, dist) {
  if (dist > RAIL_POWER_RANGE) return false;
  let cx = x + HDX[dirIndex], cy = y, cz = z + HDZ[dirIndex];
  let id = idAt(world, cx, cy, cz);
  if (!isRailId(id)) {
    if (isRailId(idAt(world, cx, cy + 1, cz))) { cy += 1; id = idAt(world, cx, cy, cz); }
    else if (isRailId(idAt(world, cx, cy - 1, cz))) { cy -= 1; id = idAt(world, cx, cy, cz); }
    else return false;
  }
  const c = T_COMP[id];
  if (c !== C.PRAIL && c !== C.ARAIL) return false;
  const meta = metaAt(world, cx, cy, cz);
  const shape = railShapeOf(id, meta);
  // The chain only runs along the rail's own axis.
  const alongX = shape === 1 || shape === 2 || shape === 3;
  const wantX = dirIndex === 1 || dirIndex === 3;
  if (alongX !== wantX) return false;
  if (receivedPower(world, cx, cy, cz) > 0) return true;
  return railChainPowered(world, cx, cy, cz, dirIndex, dist + 1);
}

function updateRail(world, st, x, y, z, id, meta, kind) {
  updateRailShape(world, x, y, z);
  if (kind === C.RAIL || kind === C.DRAIL) return;    // detector rails are cart-driven
  const v = world.getRaw(x, y, z);
  const nid = v & ID_MASK;
  if (!isRailId(nid)) return;
  const m = (v >>> 12) & 15;
  const shape = railShapeOf(nid, m);
  let powered = receivedPower(world, x, y, z) > 0;
  if (!powered) {
    const alongX = shape === 1 || shape === 2 || shape === 3;
    const a = alongX ? 1 : 0, b = alongX ? 3 : 2;
    powered = railChainPowered(world, x, y, z, a, 1) || railChainPowered(world, x, y, z, b, 1);
  }
  const was = (m & 8) !== 0;
  if (powered === was) return;
  setMeta(world, x, y, z, nid, powered ? (m | 8) : (m & ~8), 3);
}

// ---------------------------------------------------------------------------
// Comparator container readings
// ---------------------------------------------------------------------------

function safeBlockEntity(world, x, y, z) {
  if (!world || typeof world.getBlockEntity !== 'function') return null;
  try { return world.getBlockEntity(x, y, z) || null; } catch { return null; }
}

function containerFullness(view) {
  if (!view || view.size <= 0) return 0;
  let total = 0;
  let any = 0;
  for (let i = 0; i < view.size; i++) {
    const s = view.get(i);
    if (emptyStack(s)) continue;
    any = 1;
    let max = 64;
    if (_inventory && typeof _inventory.maxStackSize === 'function') {
      try { max = _inventory.maxStackSize(s) || 64; } catch { max = 64; }
    }
    total += (s.count | 0) / Math.max(1, max);
  }
  if (!any) return 0;
  return Math.min(15, Math.floor((total / view.size) * 14) + 1);
}

/** The item frame hanging on this block, if any. */
function itemFrameAt(world, x, y, z) {
  if (!world || typeof world.entitiesInAABB !== 'function') return null;
  const box = new AABB(x - 0.5, y - 0.5, z - 0.5, x + 1.5, y + 1.5, z + 1.5);
  let list = null;
  try { list = world.entitiesInAABB(box, (e) => e && !e.removed && e.type === 'item_frame'); }
  catch { return null; }
  if (!list || !list.length) return null;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (f.blockX === x && f.blockY === y && f.blockZ === z) return f;
  }
  return null;
}

/**
 * What a comparator reads out of the block in front of it: container fullness
 * plus all the odd special cases (cake, cauldron, composter, item frame,
 * lectern, end portal frame, jukebox, beehive, respawn anchor).
 * @returns {number} 0..15
 */
export function comparatorSignal(world, x, y, z) {
  if (!world) return 0;
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (id === ID_AIR) return 0;
  const meta = (v >>> 12) & 15;
  const def = getBlock(id);
  const name = def.name;

  switch (name) {
    case 'cake':
      return Math.max(0, 14 - (meta & 7) * 2);
    case 'cauldron':
      return 0;
    case 'water_cauldron': case 'powder_snow_cauldron':
      return Math.min(3, (meta & 3) || 3);
    case 'lava_cauldron':
      return 3;
    case 'composter':
      return Math.min(8, meta & 15);
    case 'beehive': case 'bee_nest':
      return Math.min(5, meta & 7);
    case 'respawn_anchor':
      return Math.min(15, meta & 15);
    case 'end_portal_frame':
      return (meta & 4) ? 15 : 0;
    case 'lectern': {
      const be = safeBlockEntity(world, x, y, z);
      if (!be || !be.book) return 0;
      const pages = Math.max(1, be.pages | 0 || 1);
      const page = Math.min(pages - 1, Math.max(0, be.page | 0));
      return pages <= 1 ? 15 : Math.min(15, 1 + Math.floor((page * 14) / (pages - 1)));
    }
    case 'jukebox': {
      const be = safeBlockEntity(world, x, y, z);
      if (!be) return 0;
      const disc = be.record || be.disc || (be.items && be.items[0] && be.items[0].item);
      if (!disc) return 0;
      const m = /music_disc_(\w+)/.exec(String(disc));
      const order = ['13', 'cat', 'blocks', 'chirp', 'far', 'mall', 'mellohi', 'stal',
        'strad', 'ward', '11', 'wait', 'otherside', 'relic', '5', 'pigstep'];
      const i = m ? order.indexOf(m[1]) : -1;
      return i < 0 ? 1 : Math.min(15, i + 1);
    }
    case 'chiseled_bookshelf': {
      const be = safeBlockEntity(world, x, y, z);
      const view = containerView(be);
      if (!view) return 0;
      let last = 0;
      for (let i = 0; i < view.size; i++) if (!emptyStack(view.get(i))) last = i + 1;
      return Math.min(15, last);
    }
    default: break;
  }

  // A picture frame on the face counts before the block itself.
  const frame = itemFrameAt(world, x, y, z);
  if (frame) return emptyStack(frame.stack) ? 0 : Math.min(15, (frame.rotation | 0) + 1);

  if (def.entityType) {
    const view = containerView(safeBlockEntity(world, x, y, z));
    if (view) return containerFullness(view);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entity-driven sensors: pressure plates and tripwire
// ---------------------------------------------------------------------------

/**
 * Wooden plates fire for anything that touches them, stone plates only for
 * something alive, weighted plates count items.
 */
function plateTriggeredBy(kind, id, e) {
  if (e.isPlayer) return true;
  if (kind === C.WEIGHTED) return e.type === 'item' || !!e.living;
  const def = getBlock(id);
  if (def.sound === 'wood') return !!(e.living || e.type === 'item' || e.isMinecart);
  return !!e.living;
}

function scanEntitySensors(world, st) {
  if ((st.tick & 1) !== 0) return;
  const list = world.entities;
  if (!list || !list.length) return;
  const seen = st.seen;
  seen.clear();

  const limit = Math.min(list.length, 600);
  for (let i = 0; i < limit; i++) {
    const e = list[i];
    if (!e || e.removed || e.noClip) continue;
    const bx = flr(e.x), bz = flr(e.z);
    const by = flr(e.y + 0.02);
    if (by < 0 || by >= WORLD_HEIGHT) continue;
    const id = idAt(world, bx, by, bz);
    const c = T_COMP[id];
    if (c !== C.PLATE && c !== C.WEIGHTED && c !== C.TRIPWIRE) continue;
    if (c !== C.TRIPWIRE && !plateTriggeredBy(c, id, e)) continue;

    const k = posKey(bx, by, bz);
    let rec = seen.get(k);
    if (!rec) { rec = { x: bx, y: by, z: bz, id, kind: c, count: 0, items: 0 }; seen.set(k, rec); }
    rec.count++;
    if (e.type === 'item') rec.items += Math.max(1, e.stack ? (e.stack.count | 0) : 1);
  }

  // Freshly triggered sensors.
  for (const [k, rec] of seen) {
    let power = 15;
    if (rec.kind === C.WEIGHTED) {
      const def = getBlock(rec.id);
      const n = rec.items || rec.count;
      power = def.name === 'heavy_weighted_pressure_plate'
        ? Math.min(15, Math.ceil(n / 10))
        : Math.min(15, n);
      if (power <= 0) power = 1;
    }
    const cur = st.pressed.get(k);
    if (cur) {
      cur.until = st.tick + (rec.kind === C.TRIPWIRE ? TRIPWIRE_HOLD : PLATE_HOLD);
      if (cur.power !== power) { cur.power = power; applySensorPower(world, st, rec, power); }
    } else {
      st.pressed.set(k, {
        x: rec.x, y: rec.y, z: rec.z, id: rec.id, kind: rec.kind, power,
        until: st.tick + (rec.kind === C.TRIPWIRE ? TRIPWIRE_HOLD : PLATE_HOLD),
      });
      applySensorPower(world, st, rec, power);
      playAt('click', rec.x + 0.5, rec.y + 0.1, rec.z + 0.5, 0.3, 0.7);
      emitVibration(world, rec.x, rec.y, rec.z, 10);
    }
  }

  // Release the ones nothing is standing on any more.
  for (const [k, rec] of st.pressed) {
    if (seen.has(k)) continue;
    if (st.tick < rec.until) continue;
    st.pressed.delete(k);
    if (idAt(world, rec.x, rec.y, rec.z) !== rec.id) continue;
    applySensorPower(world, st, rec, 0);
    playAt('click', rec.x + 0.5, rec.y + 0.1, rec.z + 0.5, 0.3, 0.6);
  }
}

function applySensorPower(world, st, rec, power) {
  const id = idAt(world, rec.x, rec.y, rec.z);
  if (id !== rec.id) return;
  if (rec.kind === C.TRIPWIRE) {
    const meta = metaAt(world, rec.x, rec.y, rec.z);
    const want = power > 0 ? (meta | 8) : (meta & ~8);
    if (want === meta) return;
    setMeta(world, rec.x, rec.y, rec.z, id, want, 1);
    wakeTripwireHooks(world, st, rec.x, rec.y, rec.z);
    return;
  }
  if (setMeta(world, rec.x, rec.y, rec.z, id, power & 15, 1)) {
    notifyPowerChange(st, world, rec.x, rec.y, rec.z);
    if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  }
}

/** Walks the string in all four directions and re-checks the hooks it ends at. */
function wakeTripwireHooks(world, st, x, y, z) {
  for (let h = 0; h < 4; h++) {
    let cx = x, cz = z;
    for (let i = 0; i < 42; i++) {
      cx += HDX[h]; cz += HDZ[h];
      const id = idAt(world, cx, y, cz);
      if (id === ID_TRIPWIRE) continue;
      if (T_COMP[id] === C.HOOK) qPush(st.q, cx, y, cz);
      break;
    }
  }
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
}

function updateTripwireHook(world, st, x, y, z, id, meta) {
  const m = meta & 7;
  if (m === 0 || m === 5) return;                 // hooks live on walls
  const h = (m - 1) & 3;
  let powered = false;
  let cx = x, cz = z;
  for (let i = 0; i < 42; i++) {
    cx += HDX[h]; cz += HDZ[h];
    const nid = idAt(world, cx, y, cz);
    if (nid === ID_TRIPWIRE) {
      if (metaAt(world, cx, y, cz) & 8) { powered = true; break; }
      continue;
    }
    break;
  }
  const was = (meta & 8) !== 0;
  if (powered === was) return;
  setMeta(world, x, y, z, id, powered ? (meta | 8) : (meta & ~8), 1);
  notifyPowerChange(st, world, x, y, z);
  playAt('click', x + 0.5, y + 0.5, z + 0.5, 0.4, powered ? 0.6 : 0.5);
}

// ---------------------------------------------------------------------------
// Daylight detectors, sculk sensors, targets and lightning rods
// ---------------------------------------------------------------------------

function registerWatcher(st, x, y, z, kind) {
  const k = posKey(x, y, z);
  if (st.watchers.has(k)) return;
  if (st.watchers.size > 512) return;
  st.watchers.set(k, { x, y, z, kind });
}

function updateDaylight(world, st, x, y, z, id, meta) {
  const d = sideData(world, x, y, z);
  const inverted = !!(d && d.inverted);
  let sky = 0;
  try {
    sky = world.getSkyLight(x, y + 1, z);
  } catch { sky = 0; }
  let factor = 1;
  try { factor = world.skyLightFactor ? world.skyLightFactor() : 1; } catch { factor = 1; }
  let p = Math.round(sky * factor);
  if (p < 0) p = 0; else if (p > 15) p = 15;
  if (inverted) p = 15 - p;
  if (setMeta(world, x, y, z, id, p, 1)) notifyPowerChange(st, world, x, y, z);
}

/**
 * Feeds a vibration to nearby sculk sensors.
 * @param {number} freq 1..15, the vanilla "frequency" of the event
 */
export function emitVibration(world, x, y, z, freq = 8) {
  if (!world) return;
  const st = stateOf(world);
  if (!st.watchers.size) return;
  for (const rec of st.watchers.values()) {
    if (rec.kind !== C.SCULK) continue;
    const dx = rec.x - x, dy = rec.y - y, dz = rec.z - z;
    if (dx * dx + dy * dy + dz * dz > 64) continue;
    activateSculk(world, st, rec.x, rec.y, rec.z, freq);
  }
}

function activateSculk(world, st, x, y, z, freq) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.SCULK) return;
  const meta = (v >>> 12) & 15;
  if (meta & 8) return;                          // already listening to something
  const d = sideData(world, x, y, z, true);
  if (d.cooldown && st.tick < d.cooldown) return;
  d.out = Math.max(1, Math.min(15, freq | 0));
  setMeta(world, x, y, z, id, meta | 8, 3);
  notifyPowerChange(st, world, x, y, z);
  schedule(world, x, y, z, T_SCULK_T, 30);
  playAt('sculk_sensor_click', x + 0.5, y + 0.5, z + 0.5, 0.7, 0.9 + d.out / 30);
  particles('sculk', x + 0.5, y + 0.7, z + 0.5, { count: 3, spread: 0.3 });
}

function fireSculk(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.SCULK) return;
  const meta = (v >>> 12) & 15;
  const d = sideData(world, x, y, z, true);
  d.out = 0;
  d.cooldown = st.tick + 10;
  if (setMeta(world, x, y, z, id, meta & ~8, 3)) notifyPowerChange(st, world, x, y, z);
}

/** Sensors also listen for movement, which is most of what makes them fun. */
function tickSculkSensors(world, st) {
  if ((st.tick % 4) !== 0 || !st.watchers.size) return;
  for (const rec of st.watchers.values()) {
    if (rec.kind !== C.SCULK) continue;
    const v = world.getRaw(rec.x, rec.y, rec.z);
    if (T_COMP[v & ID_MASK] !== C.SCULK) continue;
    if ((v >>> 12) & 8) continue;
    let list = null;
    try { list = world.entitiesNear(rec.x + 0.5, rec.y + 0.5, rec.z + 0.5, 8, (e) => e && !e.removed && (e.living || e.isPlayer)); }
    catch { list = null; }
    if (!list || !list.length) continue;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const speed = Math.abs(e.vx || 0) + Math.abs(e.vz || 0) + Math.abs(e.vy || 0);
      if (speed < 0.08) continue;
      activateSculk(world, st, rec.x, rec.y, rec.z, e.sprinting ? 13 : (e.onGround ? 10 : 12));
      break;
    }
  }
}

function pruneWatchers(world, st) {
  if ((st.tick % 40) !== 0 || !st.watchers.size) return;
  for (const [k, rec] of st.watchers) {
    const c = T_COMP[idAt(world, rec.x, rec.y, rec.z)];
    if (c !== rec.kind) st.watchers.delete(k);
  }
}

function tickDaylight(world, st) {
  if ((st.tick % 20) !== 0 || !st.watchers.size) return;
  for (const rec of st.watchers.values()) {
    if (rec.kind !== C.DAYLIGHT) continue;
    const v = world.getRaw(rec.x, rec.y, rec.z);
    const id = v & ID_MASK;
    if (T_COMP[id] !== C.DAYLIGHT) continue;
    updateDaylight(world, st, rec.x, rec.y, rec.z, id, (v >>> 12) & 15);
  }
}

function tickComparators(world, st) {
  if ((st.tick % 10) !== 0 || !st.watchers.size) return;
  for (const rec of st.watchers.values()) {
    if (rec.kind !== C.COMPARATOR) continue;
    const v = world.getRaw(rec.x, rec.y, rec.z);
    const id = v & ID_MASK;
    if (T_COMP[id] !== C.COMPARATOR) continue;
    updateComparator(world, st, rec.x, rec.y, rec.z, id, (v >>> 12) & 15);
  }
}

/**
 * Lights up a target block, as an arrow does. `offset` is the distance from the
 * middle of the face, 0..1.
 */
export function hitTarget(world, x, y, z, offset = 0, byProjectile = true) {
  if (!world) return 0;
  x = flr(x); y = flr(y); z = flr(z);
  const id = idAt(world, x, y, z);
  if (T_COMP[id] !== C.TARGET) return 0;
  const p = Math.max(1, 15 - Math.round(Math.min(1, Math.max(0, offset)) * 14));
  const st = stateOf(world);
  if (setMeta(world, x, y, z, id, p, 1)) notifyPowerChange(st, world, x, y, z);
  schedule(world, x, y, z, T_DECAY, byProjectile ? 20 : 8);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  return p;
}

/** Charges a lightning rod for the usual eight ticks. */
export function strikeLightningRod(world, x, y, z) {
  if (!world) return false;
  x = flr(x); y = flr(y); z = flr(z);
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.ROD) return false;
  const meta = (v >>> 12) & 15;
  const st = stateOf(world);
  if (setMeta(world, x, y, z, id, meta | 8, 3)) notifyPowerChange(st, world, x, y, z);
  schedule(world, x, y, z, T_DECAY, 8);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  return true;
}

function fireDecay(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  const meta = (v >>> 12) & 15;
  const c = T_COMP[id];
  if (c === C.TARGET) {
    if (setMeta(world, x, y, z, id, 0, 1)) notifyPowerChange(st, world, x, y, z);
  } else if (c === C.ROD) {
    if (setMeta(world, x, y, z, id, meta & ~8, 3)) notifyPowerChange(st, world, x, y, z);
  }
}

// ---------------------------------------------------------------------------
// Player interaction
// ---------------------------------------------------------------------------

/** Flips a lever and wakes everything it feeds. */
export function toggleLever(world, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.LEVER) return false;
  const meta = (v >>> 12) & 15;
  const on = (meta & 8) === 0;
  setMeta(world, x, y, z, id, on ? (meta | 8) : (meta & ~8), 3);
  playAt('lever', x + 0.5, y + 0.5, z + 0.5, 0.6, on ? 0.6 : 0.5);
  const st = stateOf(world);
  notifyPowerChange(st, world, x, y, z);
  const sf = mountSupportFace(meta & 7);
  const d = FACE_DIRS[sf];
  notifyPowerChange(st, world, x + d[0], y + d[1], z + d[2]);
  emitVibration(world, x, y, z, 11);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  return true;
}

/** Presses a button; it pops back out on its own. */
export function pressButton(world, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.BUTTON) return false;
  const meta = (v >>> 12) & 15;
  if (meta & 8) return false;
  const def = getBlock(id);
  const wooden = def.sound === 'wood';
  setMeta(world, x, y, z, id, meta | 8, 3);
  playAt('button', x + 0.5, y + 0.5, z + 0.5, 0.5, wooden ? 0.6 : 0.7);
  const st = stateOf(world);
  notifyPowerChange(st, world, x, y, z);
  const d = FACE_DIRS[mountSupportFace(meta & 7)];
  notifyPowerChange(st, world, x + d[0], y + d[1], z + d[2]);
  schedule(world, x, y, z, T_BUTTON_T, wooden ? 30 : 20);
  emitVibration(world, x, y, z, 11);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  return true;
}

function fireButton(world, st, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.BUTTON) return;
  const meta = (v >>> 12) & 15;
  if (!(meta & 8)) return;
  setMeta(world, x, y, z, id, meta & ~8, 3);
  playAt('button', x + 0.5, y + 0.5, z + 0.5, 0.5, 0.5);
  notifyPowerChange(st, world, x, y, z);
  const d = FACE_DIRS[mountSupportFace(meta & 7)];
  notifyPowerChange(st, world, x + d[0], y + d[1], z + d[2]);
}

/** Steps a repeater through its four delays. */
export function cycleRepeaterDelay(world, x, y, z) {
  const id = idAt(world, x, y, z);
  if (T_COMP[id] !== C.REPEATER) return false;
  const d = sideData(world, x, y, z, true);
  d.delay = ((repeaterDelay(world, x, y, z) % 4) + 1);
  playAt('click', x + 0.5, y + 0.5, z + 0.5, 0.4, 0.5 + d.delay * 0.12);
  const st = stateOf(world);
  qPush(st.q, x, y, z);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  return true;
}

/** Switches a comparator between compare and subtract. */
export function toggleComparatorMode(world, x, y, z) {
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  if (T_COMP[id] !== C.COMPARATOR) return false;
  const meta = (v >>> 12) & 15;
  const sub = (meta & 4) === 0;
  setMeta(world, x, y, z, id, sub ? (meta | 4) : (meta & ~4), 3);
  playAt('click', x + 0.5, y + 0.5, z + 0.5, 0.4, sub ? 0.7 : 0.55);
  const st = stateOf(world);
  qPush(st.q, x, y, z);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  return true;
}

/**
 * Right-click behaviour for every redstone block that has one. blockupdate.js
 * can hand off to this from `useBlock`.
 * @returns {boolean} true when the click was consumed
 */
export function useRedstoneBlock(world, x, y, z, player = null, face = FACE_UP) {
  if (!world) return false;
  x = flr(x); y = flr(y); z = flr(z);
  const v = world.getRaw(x, y, z);
  const id = v & ID_MASK;
  const meta = (v >>> 12) & 15;
  switch (T_COMP[id]) {
    case C.LEVER: return toggleLever(world, x, y, z);
    case C.BUTTON: return pressButton(world, x, y, z);
    case C.REPEATER: return cycleRepeaterDelay(world, x, y, z);
    case C.COMPARATOR: return toggleComparatorMode(world, x, y, z);
    case C.DAYLIGHT: {
      const d = sideData(world, x, y, z, true);
      d.inverted = !d.inverted;
      playAt('click', x + 0.5, y + 0.5, z + 0.5, 0.4, d.inverted ? 0.5 : 0.8);
      updateDaylight(world, stateOf(world), x, y, z, id, meta);
      return true;
    }
    case C.NOTE: {
      const be = safeBlockEntity(world, x, y, z);
      if (be) be.note = (((be.note | 0) + 1) % 25);
      playNote(world, x, y, z);
      return true;
    }
    default: return false;
  }
}

/**
 * Called when a block that redstone cares about is removed, so leftovers (a
 * piston head, a stale side record) do not linger.
 */
export function onRedstoneBlockBroken(world, x, y, z, id, meta) {
  if (!world) return;
  x = flr(x); y = flr(y); z = flr(z);
  dropSideData(world, x, y, z);
  const c = T_COMP[id];
  if (c === C.PISTON && (meta & 8)) {
    const d = FACE_DIRS[pistonFacing(meta)];
    const hx = x + d[0], hy = y + d[1], hz = z + d[2];
    if (T_COMP[idAt(world, hx, hy, hz)] === C.HEAD) world.setBlock(hx, hy, hz, ID_AIR, 0, 3);
  } else if (c === C.HEAD) {
    const d = FACE_DIRS[FACE_OPPOSITE[pistonFacing(meta)]];
    const bx = x + d[0], by = y + d[1], bz = z + d[2];
    if (T_COMP[idAt(world, bx, by, bz)] === C.PISTON) {
      setMeta(world, bx, by, bz, idAt(world, bx, by, bz), metaAt(world, bx, by, bz) & ~8, 3);
    }
  }
  const st = STATE.get(world);
  if (st) st.pressed.delete(posKey(x, y, z));
  emitVibration(world, x, y, z, 12);
}

/** Called after a redstone block is placed so it evaluates itself at once. */
export function onRedstoneBlockPlaced(world, x, y, z, id, meta) {
  if (!world) return;
  x = flr(x); y = flr(y); z = flr(z);
  const st = stateOf(world);
  if (isRailId(id)) updateRailShape(world, x, y, z);
  notifyPowerChange(st, world, x, y, z);
  if (!st.processing) drain(world, st, IMMEDIATE_BUDGET);
  emitVibration(world, x, y, z, 12);
}

// ---------------------------------------------------------------------------
// Timers and the per-tick driver
// ---------------------------------------------------------------------------

function runTimers(world, st) {
  const list = st.timers;
  if (!list.length) return;
  let fired = 0;
  for (let i = 0; i < list.length && fired < MAX_TIMERS_PER_TICK;) {
    const t = list[i];
    if (t.due > st.tick) { i++; continue; }
    // swap-remove keeps this O(1) without disturbing the rest of the scan
    const last = list.pop();
    if (i < list.length) list[i] = last;
    st.timerKeys.delete(t.key);
    fired++;
    try {
      runTimer(world, st, t);
    } catch (e) {
      console.error('[redstone] timer failed', t.kind, t.x, t.y, t.z, e);
    }
  }
  st.stats.timers += fired;
}

function runTimer(world, st, t) {
  const x = t.x, y = t.y, z = t.z;
  switch (t.kind) {
    case T_DIODE: {
      const c = T_COMP[idAt(world, x, y, z)];
      if (c === C.REPEATER) fireRepeater(world, st, x, y, z);
      else if (c === C.COMPARATOR) fireComparator(world, st, x, y, z);
      break;
    }
    case T_TORCH_T: fireTorch(world, st, x, y, z); break;
    case T_PISTON_T: firePiston(world, st, x, y, z); break;
    case T_LAMP_T: fireLamp(world, st, x, y, z); break;
    case T_BUTTON_T: fireButton(world, st, x, y, z); break;
    case T_DISPENSE: fireDispenser(world, st, x, y, z); break;
    case T_DECAY: fireDecay(world, st, x, y, z); break;
    case T_OBSERVER: fireObserver(world, st, x, y, z); break;
    case T_SCULK_T: fireSculk(world, st, x, y, z); break;
    case T_UPDATE: qPush(st.q, x, y, z); break;
    default: break;
  }
}

/**
 * One redstone step. World.tick calls this every 1/20s.
 * @param {object} world
 */
export function tickRedstone(world) {
  if (!world) return;
  const st = stateOf(world);
  st.tick++;
  try {
    runTimers(world, st);
    scanEntitySensors(world, st);
    tickDaylight(world, st);
    tickComparators(world, st);
    tickSculkSensors(world, st);
    pruneWatchers(world, st);
  } catch (e) {
    console.error('[redstone] tick failed', e);
  }
  drain(world, st, TICK_BUDGET);
}

/** Queue sizes, for the F3 overlay. */
export function redstoneStats(world) {
  const st = STATE.get(world);
  if (!st) return { queued: 0, timers: 0, pressed: 0, watchers: 0, side: 0 };
  return {
    queued: st.q.xs.length - st.q.head,
    timers: st.timers.length,
    pressed: st.pressed.size,
    watchers: st.watchers.size,
    side: st.side.size,
  };
}

export default {
  getPower, isPowered, updateRedstone, tickRedstone, tryMovePiston,
  scheduleRedstoneUpdate, strongPower, weakPower, isConductor,
  comparatorSignal, updateRailShape, toggleLever, pressButton,
  cycleRepeaterDelay, toggleComparatorMode, useRedstoneBlock, playNote,
  hitTarget, strikeLightningRod, emitVibration,
  onRedstoneBlockPlaced, onRedstoneBlockBroken, redstoneStats,
};
