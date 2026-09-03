// ============================================================================
// ai.js - Goal-based mob AI and A* pathfinding.
//
// The shape mirrors Minecraft's own brain: every mob owns an AIController that
// holds a list of Goals sorted by priority. Each goal declares a mutex mask of
// the channels it needs (movement / look / jump / target). The controller
// re-evaluates the list every few ticks: a goal may only start when no
// higher-priority running goal holds a channel it wants, and starting it stops
// any lower-priority goal that does.
//
// Movement is driven by a real A* over walkable voxel nodes with a node cap,
// followed with a look-ahead point so mobs cut corners instead of stuttering
// from block centre to block centre.
// ============================================================================
import { Game } from '../core/game.js';
import { ID_MASK, WORLD_HEIGHT, DIFFICULTY, DIM_OVERWORLD } from '../core/constants.js';
import { clamp, angleDiff, MinHeap } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { getBlock, blockByName } from '../world/blocks.js';

// ---------------------------------------------------------------------------
// Optional sibling modules. combat/projectiles/itementity import mobs.js which
// imports this file, so they are pulled in lazily and every call site degrades
// gracefully when one is missing.
// ---------------------------------------------------------------------------
const MOD = { projectiles: null, combat: null, itementity: null };
let _depsStarted = false;
function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, key) => {
    try { import(path).then((m) => { MOD[key] = m; }).catch(() => { /* optional */ }); } catch { /* ignore */ }
  };
  grab('./projectiles.js', 'projectiles');
  grab('./combat.js', 'combat');
  grab('./itementity.js', 'itementity');
}
loadDeps();

/** Fallback randomness for entities that arrive without their own RNG. */
const FALLBACK_RNG = new RNG(0x5eed1);

// ---------------------------------------------------------------------------
// Tiny shared helpers
// ---------------------------------------------------------------------------

/** Plays a positional sound if the audio engine is up. Never throws. */
function playAt(world, name, x, y, z, vol = 1, pitch = 1) {
  if (!name) return;
  try { Game.audio?.playAt?.(name, x, y, z, vol, pitch); } catch { /* audio optional */ }
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
    bypassArmor: type === 'magic' || type === 'wither' || type === 'sonic_boom',
    fire: type === 'fire' || type === 'fireball' || type === 'lava',
    magic: type === 'magic' || type === 'wither' || type === 'indirect_magic',
    projectile: type === 'arrow' || type === 'fireball' || type === 'thrown',
  };
}

/** Fires a projectile through projectiles.js. Returns the entity or null. */
function shoot(type, world, shooter, x, y, z, dx, dy, dz, opts) {
  const p = MOD.projectiles;
  if (!p || typeof p.spawnProjectile !== 'function') return null;
  try { return p.spawnProjectile(type, world, shooter, x, y, z, dx, dy, dz, opts || {}); } catch { return null; }
}

/** Drops experience orbs (used when two animals breed). */
function dropXp(world, x, y, z, amount) {
  const it = MOD.itementity;
  if (!it || typeof it.dropXP !== 'function' || !(amount > 0)) return;
  try { it.dropXP(world, x, y, z, amount | 0); } catch { /* optional */ }
}

/** The definition object of a mob, or an empty stand-in. */
const defOf = (mob) => (mob && mob.def) || EMPTY_DEF;
const EMPTY_DEF = Object.freeze({});

/** Eye-height Y of any entity, players included. */
const eyeY = (e) => e.y + (e.eyeHeight !== undefined ? e.eyeHeight : (e.height || 1) * 0.85);

/** Horizontal distance between two entities. */
function distXZ(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** True when `e` is something a mob is allowed to hunt right now. */
function isTargetable(e) {
  if (!e || e.removed || e.dead) return false;
  if (e.health !== undefined && e.health <= 0) return false;
  if (e.isPlayer || e.type === 'player') {
    const mode = e.gameMode || Game.mode;
    if (mode === 'creative' || mode === 'spectator') return false;
  }
  return true;
}

/** Difficulty gate: nothing hostile happens on peaceful. */
const peaceful = () => Game.difficulty === DIFFICULTY.PEACEFUL;

/** The RNG a goal should use. */
const rngOf = (mob) => (mob && mob.rng) || FALLBACK_RNG;

// ---------------------------------------------------------------------------
// Block classification used by the pathfinder
// ---------------------------------------------------------------------------

// Path maluses, in "extra nodes of cost". Vanilla numbers, roughly.
const MALUS_WATER = 8;
const MALUS_LAVA = 8;
const MALUS_COBWEB = 8;
const MALUS_DANGER = 8;      // standing next to fire or lava
const MALUS_DOOR = 1;        // a closed door a mob has to push open
const MALUS_BREAK_DOOR = 6;  // a door it has to chew through
const MALUS_HAZARD = 12;     // berry bushes and friends
const COST_JUMP = 0.6;       // hopping up a block
const COST_FALL = 0.4;       // per block of controlled drop

const DANGEROUS_NAMES = new Set([
  'fire', 'soul_fire', 'campfire', 'soul_campfire', 'magma_block', 'lava_cauldron',
]);
const HAZARD_NAMES = new Set(['sweet_berry_bush', 'wither_rose', 'powder_snow']);

/** True for a block model whose metadata carries an open/closed state. */
function isDoorLike(def) {
  const m = def.model;
  return m === 'door' || m === 'fence_gate' || m === 'trapdoor';
}

/** True when a door-like block is currently open. */
function isDoorOpen(def, meta) {
  if (def.model === 'door') return (meta & 8) !== 0;
  return (meta & 4) !== 0;   // fence gates and trapdoors keep "open" in bit 2
}

/** Wooden doors and gates can be pushed open; iron ones need redstone. */
function isOpenableDoor(def) {
  if (!isDoorLike(def)) return false;
  if (def.name === 'iron_door' || def.name === 'iron_trapdoor') return false;
  return def.model !== 'trapdoor';   // mobs never operate trapdoors
}

/**
 * Extra cost of standing inside one block, or -1 when it is impassable.
 * `prof` is the mob path profile built by pathProfile().
 */
function blockCost(raw, prof) {
  const id = raw & ID_MASK;
  if (id === 0) return 0;
  const def = getBlock(id);
  const meta = (raw >>> 12) & 15;

  if (def.liquid === 'lava') return prof.fireImmune ? MALUS_LAVA : -1;
  if (def.liquid === 'water') {
    if (prof.water) return 0;
    if (!prof.canSwim) return -1;
    return MALUS_WATER;
  }
  if (def.solid && def.collision !== 'none') {
    if (isDoorLike(def)) {
      if (isDoorOpen(def, meta)) return 0;
      if (prof.openDoors && isOpenableDoor(def)) return MALUS_DOOR;
      if (prof.breakDoors && def.model === 'door' && def.name !== 'iron_door') return MALUS_BREAK_DOOR;
    }
    return -1;
  }
  if (def.name === 'cobweb') return MALUS_COBWEB;
  if (DANGEROUS_NAMES.has(def.name)) return prof.fireImmune ? 2 : -1;
  if (HAZARD_NAMES.has(def.name)) return MALUS_HAZARD;
  return 0;
}

/** Movement profile derived from a mob definition, cached per path search. */
function pathProfile(mob) {
  const def = defOf(mob);
  const ai = def.ai || [];
  const flying = !!(def.flying || mob.flyingMob || (mob.noGravity && !def.waterMob));
  const water = !!(def.waterMob || mob.waterMob);
  return {
    height: clamp(Math.ceil((mob.height || 1.8) - 0.06), 1, 4),
    width: mob.width || 0.6,
    wide: (mob.width || 0.6) > 1.05,
    flying,
    water,
    amphibious: !!def.amphibious,
    canSwim: mob.canSwim !== false && !def.avoidWater,
    fireImmune: !!(def.fireImmune || mob.fireImmune),
    maxFall: def.immuneToFall || flying || water ? 16 : 3,
    openDoors: def.canOpenDoors !== undefined ? !!def.canOpenDoors : ai.indexOf('open_door') >= 0,
    breakDoors: def.canBreakDoors !== undefined ? !!def.canBreakDoors : ai.indexOf('break_door') >= 0,
    avoidSun: !!mob._avoidSun,
  };
}

/**
 * Per-search scratch: caches the cost of every column it looks at, because A*
 * asks about the same block from several directions.
 */
function makeCtx(world, prof, ox = 0, oz = 0) {
  const cache = new Map();
  const ctx = {
    world, prof, ox, oz,
    key(x, y, z) {
      return ((x - ox + 256) & 511) | (((z - oz + 256) & 511) << 9) | ((y & 127) << 18);
    },
    /** Cost of the mob's whole body standing with its feet in this block, or -1. */
    columnCost(x, y, z) {
      if (y < 0 || y + prof.height > WORLD_HEIGHT) return -1;
      const k = ctx.key(x, y, z);
      const hit = cache.get(k);
      if (hit !== undefined) return hit;
      let cost = 0;
      for (let h = 0; h < prof.height; h++) {
        const c = blockCost(world.getRaw(x, y + h, z), prof);
        if (c < 0) { cost = -1; break; }
        cost += c;
      }
      // A body wider than one block has to fit its whole footprint.
      if (cost >= 0 && prof.wide) {
        outer:
        for (let dx = -1; dx <= 1 && cost >= 0; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            for (let h = 0; h < prof.height; h++) {
              if (blockCost(world.getRaw(x + dx, y + h, z + dz), prof) < 0) { cost = -1; break outer; }
            }
          }
        }
      }
      // Standing next to fire or lava is legal but strongly discouraged.
      if (cost >= 0 && !prof.fireImmune) {
        for (let i = 0; i < 4; i++) {
          const d = CARDINALS[i];
          const nd = getBlock(world.getBlock(x + d[0], y, z + d[1]));
          if (nd.liquid === 'lava' || DANGEROUS_NAMES.has(nd.name)) { cost += MALUS_DANGER; break; }
        }
      }
      if (cost >= 0 && prof.avoidSun && world.canSeeSky && world.canSeeSky(x, y, z)) cost += 6;
      cache.set(k, cost);
      return cost;
    },
    /** True when a mob can hold this position without falling. */
    supported(x, y, z) {
      if (prof.flying) return true;
      const here = getBlock(world.getBlock(x, y, z));
      if (here.liquid === 'water' && (prof.water || prof.canSwim)) return true;
      if (here.climbable) return true;
      if (prof.water && !prof.amphibious) return false;   // fish need water, not floors
      const below = getBlock(world.getBlock(x, y - 1, z));
      if (below.solid && below.collision !== 'none') return true;
      if (below.climbable) return true;
      if (below.liquid === 'water' && (prof.water || prof.canSwim)) return true;
      return false;
    },
    /** Walkable == passable body space plus something to stand on. */
    standCost(x, y, z) {
      const c = ctx.columnCost(x, y, z);
      if (c < 0) return -1;
      return ctx.supported(x, y, z) ? c : -1;
    },
  };
  return ctx;
}

const CARDINALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Nearest y near `y` (within `span`) where the mob can stand, or null. */
function groundNear(ctx, x, y, z, span = 4) {
  if (ctx.standCost(x, y, z) >= 0) return y;
  for (let d = 1; d <= span; d++) {
    if (ctx.standCost(x, y - d, z) >= 0) return y - d;
    if (ctx.standCost(x, y + d, z) >= 0) return y + d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line of sight
// ---------------------------------------------------------------------------

/**
 * Voxel-stepping clear-line test between two world points. Blocks with no
 * collision (plants, torches, fluids) never block the line.
 * @returns {boolean} true when nothing solid sits between the two points
 */
export function isPathClear(world, x0, y0, z0, x1, y1, z1) {
  if (!world) return false;
  let dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-4) return true;
  if (len > 192) return false;
  dx /= len; dy /= len; dz /= len;

  let x = Math.floor(x0), y = Math.floor(y0), z = Math.floor(z0);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const invX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const invY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const invZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 - x0 : x0 - x) * invX) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 - y0 : y0 - y) * invY) : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 - z0 : z0 - z) * invZ) : Infinity;

  for (let guard = 0; guard < 512; guard++) {
    let t;
    if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += invX; }
    else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += invY; }
    else { z += stepZ; t = tMaxZ; tMaxZ += invZ; }
    if (t > len) return true;
    if (y < 0 || y >= WORLD_HEIGHT) continue;
    const def = getBlock(world.getBlock(x, y, z));
    if (def.solid && def.collision !== 'none' && def.collision !== 'thin') return false;
  }
  return true;
}

/**
 * Ray test between two entities, eyes to eyes.
 * @param {object} world @param {object} from @param {object} to
 * @returns {boolean}
 */
export function canSee(world, from, to) {
  if (!world || !from || !to) return false;
  return isPathClear(world, from.x, eyeY(from), from.z, to.x, eyeY(to), to.z);
}

// ---------------------------------------------------------------------------
// A*
// ---------------------------------------------------------------------------

const SEARCH_RADIUS = 56;   // hard bound so node keys stay packed and cheap

/** Octile distance plus vertical travel: admissible for our move costs. */
function heuristic(x, y, z, gx, gy, gz) {
  const adx = Math.abs(x - gx), adz = Math.abs(z - gz);
  const hi = adx > adz ? adx : adz, lo = adx > adz ? adz : adx;
  return hi + 0.4 * lo + Math.abs(y - gy);
}

/**
 * A* over walkable voxel nodes.
 * @param {object} world
 * @param {object} mob     provides size, swim/fly/door abilities and fall tolerance
 * @param {number} tx @param {number} ty @param {number} tz  destination (world coords)
 * @param {number} [maxNodes] expansion cap
 * @param {object} [opts] `{ partial: true }` accepts the closest node reached
 * @returns {Array<{x:number,y:number,z:number}>|null} smoothed waypoints, or null
 */
export function findPath(world, mob, tx, ty, tz, maxNodes = 400, opts = null) {
  if (!world || !mob) return null;
  const prof = pathProfile(mob);
  const sx = Math.floor(mob.x), sz = Math.floor(mob.z);
  const ctx = makeCtx(world, prof, sx, sz);

  let sy = Math.floor(mob.y + 0.02);
  if (ctx.standCost(sx, sy, sz) < 0) {
    const g = groundNear(ctx, sx, sy, sz, 3);
    if (g !== null) sy = g;
  }
  const gx = Math.floor(tx), gz = Math.floor(tz);
  let gy = Math.floor(ty);
  const gAdj = groundNear(ctx, gx, gy, gz, 3);
  if (gAdj !== null) gy = gAdj;

  if (sx === gx && sz === gz && Math.abs(sy - gy) <= 1) {
    return [{ x: gx + 0.5, y: gy, z: gz + 0.5 }];
  }
  if (Math.abs(gx - sx) > SEARCH_RADIUS || Math.abs(gz - sz) > SEARCH_RADIUS) return null;

  const nodes = new Map();
  const open = new MinHeap((n) => n.f);
  const start = {
    x: sx, y: sy, z: sz, g: 0,
    h: heuristic(sx, sy, sz, gx, gy, gz), f: 0, parent: null, closed: false,
  };
  start.f = start.h * 1.001;
  nodes.set(ctx.key(sx, sy, sz), start);
  open.push(start);

  const partial = !!(opts && opts.partial);
  const reach = (opts && opts.reach) || 0;
  let best = start, found = null, expanded = 0;

  while (open.size > 0 && expanded < maxNodes) {
    const cur = open.pop();
    if (cur.closed) continue;
    cur.closed = true;
    expanded++;
    if (cur.h < best.h) best = cur;
    if ((cur.x === gx && cur.z === gz && Math.abs(cur.y - gy) <= 1) || (reach > 0 && cur.h <= reach)) {
      found = cur;
      break;
    }
    expandNode(ctx, cur, prof, nodes, open, gx, gy, gz);
  }

  let end = found;
  if (!end && partial && best !== start && best.h < start.h - 1) end = best;
  if (!end) return null;

  const pts = [];
  for (let n = end; n; n = n.parent) pts.push({ x: n.x + 0.5, y: n.y, z: n.z + 0.5 });
  pts.reverse();
  pts.shift();                       // the mob is already standing on the first node
  if (!pts.length) return null;
  // Aim at the exact request when the last node is the goal block.
  const last = pts[pts.length - 1];
  if (Math.floor(last.x) === gx && Math.floor(last.z) === gz) { last.x = tx; last.z = tz; }
  return smoothPath(ctx, prof, pts);
}

/** Pushes every legal successor of `cur` into the open set. */
function expandNode(ctx, cur, prof, nodes, open, gx, gy, gz) {
  for (let i = 0; i < DIRS8.length; i++) {
    const dx = DIRS8[i][0], dz = DIRS8[i][1];
    const diag = dx !== 0 && dz !== 0;
    const nx = cur.x + dx, nz = cur.z + dz;
    if (Math.abs(nx - ctx.ox) > SEARCH_RADIUS || Math.abs(nz - ctx.oz) > SEARCH_RADIUS) continue;

    // A diagonal is only legal when both orthogonal neighbours are open, so
    // mobs never squeeze through the seam between two blocks.
    if (diag && (ctx.columnCost(cur.x + dx, cur.y, cur.z) < 0 || ctx.columnCost(cur.x, cur.y, cur.z + dz) < 0)) continue;

    let ny = cur.y;
    let extra = 0;
    let cost = ctx.columnCost(nx, ny, nz);
    if (cost < 0) {
      // Step or jump up exactly one block, and only straight ahead.
      if (diag || prof.flying) continue;
      if (ctx.columnCost(cur.x, cur.y + 1, cur.z) < 0) continue;   // no headroom to hop
      ny = cur.y + 1;
      cost = ctx.columnCost(nx, ny, nz);
      if (cost < 0) continue;
      extra += COST_JUMP;
    }
    if (!ctx.supported(nx, ny, nz)) {
      if (prof.flying) {
        // Air movers may hover anywhere passable.
      } else if (diag) {
        continue;                                 // never step off a corner
      } else {
        let fy = ny, drop = 0;
        while (fy > 1 && drop < prof.maxFall + 1 && !ctx.supported(nx, fy, nz)) {
          if (ctx.columnCost(nx, fy - 1, nz) < 0) break;
          fy--; drop++;
        }
        if (!ctx.supported(nx, fy, nz) || drop > prof.maxFall) continue;
        ny = fy;
        extra += drop * COST_FALL;
        cost = ctx.columnCost(nx, ny, nz);
        if (cost < 0) continue;
      }
    }
    pushNode(ctx, cur, nx, ny, nz, (diag ? 1.4 : 1) + extra + cost, nodes, open, gx, gy, gz);
  }

  // Fliers and swimmers also move straight up and down.
  if (prof.flying || prof.water) {
    for (let s = -1; s <= 1; s += 2) {
      const ny = cur.y + s;
      if (ny < 1 || ny + prof.height >= WORLD_HEIGHT) continue;
      const c = ctx.columnCost(cur.x, ny, cur.z);
      if (c < 0) continue;
      if (!prof.flying && !ctx.supported(cur.x, ny, cur.z)) continue;
      pushNode(ctx, cur, cur.x, ny, cur.z, 1 + c, nodes, open, gx, gy, gz);
    }
  }
}

/** Relaxes one successor edge. */
function pushNode(ctx, cur, x, y, z, stepCost, nodes, open, gx, gy, gz) {
  const key = ctx.key(x, y, z);
  const g = cur.g + stepCost;
  let n = nodes.get(key);
  if (n) {
    if (n.closed || g >= n.g) return;
    n.g = g;
    n.parent = cur;
    n.f = g + n.h * 1.001;
    open.push(n);
    return;
  }
  n = { x, y, z, g, h: heuristic(x, y, z, gx, gy, gz), f: 0, parent: cur, closed: false };
  n.f = g + n.h * 1.001;
  nodes.set(key, n);
  open.push(n);
}

/** True when a mob can walk the straight segment a->b without leaving the floor. */
function straightWalkable(ctx, prof, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) return true;
  const steps = Math.ceil(len / 0.45);
  const half = Math.min(0.49, (prof.width || 0.6) * 0.5);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = a.x + dx * t, pz = a.z + dz * t;
    for (let cx = -1; cx <= 1; cx += 2) {
      for (let cz = -1; cz <= 1; cz += 2) {
        const bx = Math.floor(px + cx * half), bz = Math.floor(pz + cz * half);
        if (ctx.standCost(bx, a.y, bz) < 0) return false;
      }
    }
  }
  return true;
}

/** String-pulls the raw node chain into a shorter list of waypoints. */
function smoothPath(ctx, prof, pts) {
  if (pts.length < 3) return pts;
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    const limit = Math.min(pts.length - 1, i + 8);
    let j = limit;
    for (; j > i + 1; j--) {
      if (pts[j].y === pts[i].y && straightWalkable(ctx, prof, pts[i], pts[j])) break;
    }
    out.push(pts[j]);
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Random destinations
// ---------------------------------------------------------------------------

/** How many of the four neighbours of a node are walkable (0..4). */
function openness(ctx, x, y, z) {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const d = CARDINALS[i];
    if (ctx.standCost(x + d[0], y, z + d[1]) >= 0) n++;
  }
  return n;
}

/** A unit vector pointing away from the walls closest to the mob. */
function openDirection(ctx, mob) {
  let ax = 0, az = 0;
  const bx = Math.floor(mob.x), by = Math.floor(mob.y + 0.02), bz = Math.floor(mob.z);
  for (let i = 0; i < DIRS8.length; i++) {
    const dx = DIRS8[i][0], dz = DIRS8[i][1];
    const open = ctx.standCost(bx + dx * 2, by, bz + dz * 2) >= 0 ? 1 : -1;
    ax += dx * open; az += dz * open;
  }
  const len = Math.sqrt(ax * ax + az * az);
  if (len < 0.2) return null;
  return { x: ax / len, z: az / len };
}

/**
 * Picks a random spot within `radius` the mob could actually stand on,
 * biased away from walls so wandering mobs drift into open ground.
 * @returns {{x:number,y:number,z:number}|null}
 */
export function randomReachablePoint(world, mob, radius = 10) {
  if (!world || !mob) return null;
  const prof = pathProfile(mob);
  const ctx = makeCtx(world, prof, Math.floor(mob.x), Math.floor(mob.z));
  const rng = rngOf(mob);
  const bias = prof.flying || prof.water ? null : openDirection(ctx, mob);
  const baseAngle = bias ? Math.atan2(bias.z, bias.x) : 0;
  let best = null, bestScore = -Infinity;

  for (let i = 0; i < 14; i++) {
    let ang = rng.next() * Math.PI * 2;
    if (bias && rng.next() < 0.7) ang = baseAngle + (rng.next() - 0.5) * 2.2;
    const dist = 2 + rng.next() * Math.max(2, radius - 2);
    const x = Math.floor(mob.x + Math.cos(ang) * dist);
    const z = Math.floor(mob.z + Math.sin(ang) * dist);
    let y;
    if (prof.flying) {
      y = clamp(Math.floor(mob.y + (rng.next() - 0.4) * radius), 2, WORLD_HEIGHT - prof.height - 1);
      if (ctx.columnCost(x, y, z) < 0) continue;
    } else {
      y = groundNear(ctx, x, Math.floor(mob.y + 0.02), z, prof.water ? 5 : 4);
      if (y === null) continue;
    }
    const cost = prof.flying ? ctx.columnCost(x, y, z) : ctx.standCost(x, y, z);
    if (cost < 0) continue;
    const score = dist * 0.4 + openness(ctx, x, y, z) * 1.5 - cost + rng.next() * 0.8;
    if (score > bestScore) { bestScore = score; best = { x: x + 0.5, y, z: z + 0.5 }; }
  }
  return best;
}

/** A point `dist` blocks away from `avoid`, on the far side of the mob. */
function fleePoint(world, mob, avoidX, avoidZ, dist = 10) {
  const prof = pathProfile(mob);
  const ctx = makeCtx(world, prof, Math.floor(mob.x), Math.floor(mob.z));
  const rng = rngOf(mob);
  let ax = mob.x - avoidX, az = mob.z - avoidZ;
  const len = Math.sqrt(ax * ax + az * az);
  if (len < 0.01) { ax = rng.next() - 0.5; az = rng.next() - 0.5; }
  else { ax /= len; az /= len; }
  const base = Math.atan2(az, ax);
  for (let i = 0; i < 12; i++) {
    const ang = base + (rng.next() - 0.5) * 1.6;
    const d = dist * (0.5 + rng.next() * 0.5);
    const x = Math.floor(mob.x + Math.cos(ang) * d);
    const z = Math.floor(mob.z + Math.sin(ang) * d);
    if (prof.flying) {
      const y = clamp(Math.floor(mob.y + (rng.next() - 0.3) * 6), 2, WORLD_HEIGHT - 3);
      if (ctx.columnCost(x, y, z) >= 0) return { x: x + 0.5, y, z: z + 0.5 };
      continue;
    }
    const y = groundNear(ctx, x, Math.floor(mob.y + 0.02), z, 4);
    if (y === null) continue;
    if (ctx.standCost(x, y, z) < 0) continue;
    return { x: x + 0.5, y, z: z + 0.5 };
  }
  return null;
}

/** Nearest block of `name` within a small box, or null. */
function findBlockNear(world, cx, cy, cz, radius, match) {
  let best = null, bestD = Infinity;
  const x0 = Math.floor(cx), y0 = Math.floor(cy), z0 = Math.floor(cz);
  for (let dy = -radius; dy <= radius; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= WORLD_HEIGHT) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const x = x0 + dx, z = z0 + dz;
        if (!match(world.getBlock(x, y, z), x, y, z)) continue;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = { x, y, z }; }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

// Mutex channels. Two goals may run together only when their masks are disjoint.
const MUTEX_MOVE = 1;
const MUTEX_LOOK = 2;
const MUTEX_JUMP = 4;
const MUTEX_TARGET = 8;

/** name -> factory(mob, args) -> Goal */
export const GOALS = {};

/**
 * Registers a goal factory under a canonical name.
 * @param {string} name @param {(mob:object, args:object)=>Goal} factory
 */
export function defineGoal(name, factory) {
  GOALS[name] = factory;
  return factory;
}

/**
 * Base class for every goal. Subclasses override canStart/start/tick/stop and
 * set `priority` (lower runs first) plus `mutex` (channels they occupy).
 */
export class Goal {
  /** @param {object} mob @param {object} [args] */
  constructor(mob, args = {}) {
    this.mob = mob;
    this.args = args || {};
    this.ai = null;           // assigned by AIController right after construction
    this.name = 'goal';
    this.priority = 5;
    this.mutex = MUTEX_MOVE;
    this.running = false;
  }

  /** The world the mob currently lives in. */
  get world() { return this.mob.world; }
  /** The mob's deterministic RNG. */
  get rng() { return rngOf(this.mob); }
  /** The mob definition. */
  get def() { return defOf(this.mob); }
  /** Shared attack target. */
  get target() { return this.ai ? this.ai.target : this.mob.target; }

  /** True when the goal wants to begin this tick. */
  canStart() { return false; }
  /** Called once when the goal takes its channels. */
  start() {}
  /** Called every tick while running. */
  tick() {}
  /** Called once when the goal loses its channels. */
  stop() {}
  /** Defaults to re-asking canStart, exactly like vanilla. */
  canContinue() { return this.canStart(); }

  // ---- convenience wrappers ----------------------------------------------
  /** Walk toward a point through the controller's navigator. */
  moveTo(x, y, z, speed = 1) { if (this.ai) this.ai.moveTo(x, y, z, speed); }
  /** Stop navigating (velocity decays on its own). */
  stopMoving() { if (this.ai) this.ai.stopMoving(); }
  /** Point the head at a world position. */
  lookAt(x, y, z, speed) { if (this.ai) this.ai.lookAt(x, y, z, speed); }
  /** Point the head at an entity's eyes. */
  lookAtEntity(e, speed) { if (e) this.lookAt(e.x, eyeY(e), e.z, speed); }
  /** Jump if grounded. */
  jump() { if (this.ai) this.ai.jump(); }
  /** Set the shared attack target. */
  setTarget(e) { if (this.ai) this.ai.setTarget(e); else this.mob.target = e || null; }
  /** Nearest live player within range. */
  nearestPlayer(range) {
    const mob = this.mob;
    if (mob.nearestPlayer) return mob.nearestPlayer(range);
    const w = this.world;
    if (!w || !w.nearestPlayer) return null;
    const p = w.nearestPlayer(mob.x, mob.y, mob.z, range);
    return isTargetable(p) ? p : null;
  }
}

// ---------------------------------------------------------------------------
// AIController
// ---------------------------------------------------------------------------

const warnedGoals = new Set();

/** Blocks-per-second per point of the `speed` attribute (0.23 ~ 4.1 b/s). */
const SPEED_SCALE = 18;

/**
 * Priority-based goal selector plus the navigator every goal steers through.
 */
export class AIController {
  /**
   * @param {object} mob
   * @param {Array<string|object>} goalNames goal names, optionally `name:arg`
   */
  constructor(mob, goalNames = []) {
    this.mob = mob;
    this.entries = [];
    this.running = [];
    this.target = null;
    this.tickCount = (mob && mob.id ? mob.id * 7 : 0) & 7;

    // navigation
    this.path = null;
    this.pathIndex = 0;
    this.pathAge = 0;
    this.pathDestX = 0; this.pathDestY = 0; this.pathDestZ = 0;
    this.destX = 0; this.destY = 0; this.destZ = 0;
    this.speedFactor = 1;
    this.repathCooldown = 0;
    this.maxPathNodes = 400;
    this.moveRequested = false;
    this.movedLastTick = false;
    this.stuckTimer = 0;
    this.stuckCount = 0;
    this.lastPosX = mob ? mob.x : 0;
    this.lastPosZ = mob ? mob.z : 0;
    this.lookLocked = false;

    for (let i = 0; i < goalNames.length; i++) this.addGoal(goalNames[i]);
    this.entries.sort((a, b) => a.priority - b.priority);
  }

  /** Instantiates one goal from `'name'`, `'name:arg'` or `{ name, ... }`. */
  addGoal(spec) {
    let name = spec, args = {};
    if (spec && typeof spec === 'object') {
      name = spec.name;
      args = spec;
    } else if (typeof spec === 'string' && spec.indexOf(':') > 0) {
      const parts = spec.split(':');
      name = parts[0];
      args = { params: parts.slice(1) };
    }
    const factory = GOALS[name];
    if (!factory) {
      if (!warnedGoals.has(name)) { warnedGoals.add(name); console.warn('[ai] unknown goal:', name); }
      return null;
    }
    let goal;
    try { goal = factory(this.mob, args); } catch (e) { console.error('[ai] goal init failed:', name, e); return null; }
    if (!goal) return null;
    goal.ai = this;
    goal.name = name;
    const entry = { name, goal, priority: goal.priority, mutex: goal.mutex, running: false };
    this.entries.push(entry);
    return entry;
  }

  // ---- goal selection ----------------------------------------------------

  /** True when no higher-priority running goal holds a channel `e` needs. */
  isCompatible(e) {
    for (let i = 0; i < this.running.length; i++) {
      const o = this.running[i];
      if (o === e) continue;
      if (o.priority < e.priority && (o.mutex & e.mutex) !== 0) return false;
    }
    return true;
  }

  /** Starts a goal and records it as running. */
  startGoal(e) {
    e.running = true;
    this.running.push(e);
    try { e.goal.running = true; e.goal.start(); } catch (err) { console.error('[ai] start', e.name, err); this.stopGoal(e); }
  }

  /** Stops a goal and releases its channels. */
  stopGoal(e) {
    const i = this.running.indexOf(e);
    if (i >= 0) this.running.splice(i, 1);
    e.running = false;
    e.goal.running = false;
    try { e.goal.stop(); } catch (err) { console.error('[ai] stop', e.name, err); }
  }

  /** One pass of the vanilla-style selector. */
  selectGoals() {
    // 1. Drop goals that no longer apply or lost a channel.
    for (let i = this.running.length - 1; i >= 0; i--) {
      const e = this.running[i];
      let keep = false;
      try { keep = !!e.goal.canContinue(); } catch (err) { console.error('[ai] canContinue', e.name, err); }
      if (!keep || !this.isCompatible(e)) this.stopGoal(e);
    }
    // 2. Try to start everything else, highest priority first.
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.running) continue;
      if (!this.isCompatible(e)) continue;
      let want = false;
      try { want = !!e.goal.canStart(); } catch (err) { console.error('[ai] canStart', e.name, err); }
      if (!want) continue;
      // Preempt every lower-priority goal that shares a channel.
      for (let j = this.running.length - 1; j >= 0; j--) {
        const o = this.running[j];
        if (o !== e && o.priority > e.priority && (o.mutex & e.mutex) !== 0) this.stopGoal(o);
      }
      if (this.isCompatible(e)) this.startGoal(e);
    }
  }

  /** Called 20x/second by Mob.tick. */
  tick() {
    const mob = this.mob;
    if (!mob || mob.removed || !mob.world) return;
    this.tickCount++;
    if (this.repathCooldown > 0) this.repathCooldown--;
    if (this.pathAge < 1e6) this.pathAge++;

    if (this.target && !isTargetable(this.target)) this.setTarget(null);
    if (this.target && mob.followRange && mob.distanceToSq(this.target.x, this.target.y, this.target.z) >
        mob.followRange * mob.followRange * 2.25) {
      this.setTarget(null);
    }

    this.movedLastTick = this.moveRequested;
    this.moveRequested = false;
    this.lookLocked = false;

    // Re-evaluating every third tick is enough and keeps a crowd cheap.
    if ((this.tickCount % 3) === 0) this.selectGoals();

    const snapshot = this.running.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const e = snapshot[i];
      if (!e.running) continue;
      try { e.goal.tick(); } catch (err) { console.error('[ai] tick', e.name, err); this.stopGoal(e); }
    }

    if (!this.moveRequested) {
      // Nobody asked to move this tick: let the path go stale rather than
      // walking on toward a destination no goal cares about any more.
      if (this.movedLastTick) this.stopMoving();
    } else {
      this.checkStuck();
    }
  }

  // ---- target ------------------------------------------------------------

  /** Sets the shared attack target on both the controller and the mob. */
  setTarget(e) {
    this.target = e || null;
    if (this.mob) this.mob.target = this.target;
  }

  // ---- navigation --------------------------------------------------------

  /** Clears the active path. */
  stopMoving() {
    this.path = null;
    this.pathIndex = 0;
    this.moveRequested = false;
  }

  /** Desired ground speed in blocks/second for a goal-supplied multiplier. */
  speedFor(factor) {
    const mob = this.mob;
    let base = (mob.moveSpeed || defOf(mob).speed || 0.25) * SPEED_SCALE * (factor || 1);
    if (mob.baby) base *= 1.15;
    if (mob.hasEffect) {
      if (mob.hasEffect('speed')) base *= 1 + 0.2 * ((mob.getEffect('speed')?.level ?? 0) + 1);
      if (mob.hasEffect('slowness')) base *= Math.max(0.1, 1 - 0.15 * ((mob.getEffect('slowness')?.level ?? 0) + 1));
    }
    return base;
  }

  /**
   * Walks toward a world position, pathing around obstacles.
   * Re-paths when the destination moves or the mob drifts off the route, and
   * falls back to direct steering when no path exists.
   */
  moveTo(x, y, z, speed = 1) {
    const mob = this.mob;
    if (!mob || !mob.world) return false;
    this.moveRequested = true;
    this.speedFactor = speed;
    this.destX = x; this.destY = y; this.destZ = z;

    const ddx = x - this.pathDestX, ddz = z - this.pathDestZ;
    const destMoved = ddx * ddx + ddz * ddz > 2.25 || Math.abs(y - this.pathDestY) > 2;
    let drifted = false;
    if (this.path && this.pathIndex < this.path.length) {
      const w = this.path[this.pathIndex];
      const dx = w.x - mob.x, dz = w.z - mob.z;
      drifted = dx * dx + dz * dz > 9 || Math.abs(w.y - mob.y) > 3.5;
    }
    if ((!this.path || destMoved || drifted || this.pathAge > 100) && this.repathCooldown <= 0) {
      this.repath(x, y, z);
    }

    if (this.path && this.pathIndex < this.path.length) this.followPath(speed);
    else this.steer(x, y, z, speed);
    return true;
  }

  /** Runs A* toward a destination and installs the result. */
  repath(x, y, z) {
    const mob = this.mob;
    this.pathDestX = x; this.pathDestY = y; this.pathDestZ = z;
    this.pathAge = 0;
    this.pathIndex = 0;
    const p = findPath(mob.world, mob, x, y, z, this.maxPathNodes, { partial: true });
    this.path = p && p.length ? p : null;
    // Failed searches are expensive; back off harder than successful ones.
    this.repathCooldown = this.path ? 8 : 24;
    return this.path;
  }

  /** Advances along the path and steers at a look-ahead point. */
  followPath(speed) {
    const mob = this.mob;
    const p = this.path;
    const reach = Math.max(0.4, mob.width * 0.5 + 0.2);
    const reachSq = reach * reach;
    while (this.pathIndex < p.length) {
      const w = p[this.pathIndex];
      const dx = w.x - mob.x, dz = w.z - mob.z;
      const dy = w.y - mob.y;
      if (dx * dx + dz * dz < reachSq && dy < 1.15 && dy > -2.5) this.pathIndex++;
      else break;
    }
    if (this.pathIndex >= p.length) {
      this.path = null;
      this.steer(this.destX, this.destY, this.destZ, speed);
      return;
    }
    const cur = p[this.pathIndex];
    let tx = cur.x, ty = cur.y, tz = cur.z;
    const nxt = p[this.pathIndex + 1];
    if (nxt && nxt.y === cur.y) {
      // Slide the aim point past the corner so the mob turns early.
      const dx = nxt.x - cur.x, dz = nxt.z - cur.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const ahead = Math.min(1, len);
      tx = cur.x + (dx / len) * ahead * 0.6;
      tz = cur.z + (dz / len) * ahead * 0.6;
      ty = cur.y;
    }
    this.steer(tx, ty, tz, speed);
  }

  /** Applies velocity toward a point, plus body yaw and auto-jumping. */
  steer(tx, ty, tz, speed) {
    const mob = this.mob;
    const flying = !!(defOf(mob).flying || mob.flyingMob || (mob.noGravity && !mob.waterMob));
    let dx = tx - mob.x, dz = tz - mob.z;
    const dy = ty - mob.y;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const want = this.speedFor(speed);

    if (dist > 0.02) {
      dx /= dist; dz /= dist;
      if (flying) {
        const a = 0.22;
        mob.vx += (dx * want - mob.vx) * a;
        mob.vz += (dz * want - mob.vz) * a;
        mob.vy += (clamp(dy, -1.5, 1.5) * want * 0.55 - mob.vy) * a;
      } else if (mob.inWater || mob.inLava) {
        const a = 0.18;
        mob.vx += (dx * want * 0.9 - mob.vx) * a;
        mob.vz += (dz * want * 0.9 - mob.vz) * a;
        if (mob.waterMob) mob.vy += (clamp(dy, -1, 1) * want * 0.5 - mob.vy) * a;
        else if (dy > 0.05 || mob.horizontalCollision) mob.jumping = true;
      } else if (mob.onGround) {
        // Friction eats part of the velocity between ticks; compensate so the
        // average ground speed lands on `want`.
        const boost = 1.16;
        mob.vx = dx * want * boost;
        mob.vz = dz * want * boost;
      } else {
        mob.vx += dx * want * 0.09;
        mob.vz += dz * want * 0.09;
        const h = Math.sqrt(mob.vx * mob.vx + mob.vz * mob.vz);
        const cap = want * 1.35;
        if (h > cap) { mob.vx = (mob.vx / h) * cap; mob.vz = (mob.vz / h) * cap; }
      }
      const yaw = Math.atan2(-dx, dz);
      mob.yaw += angleDiff(mob.yaw, yaw) * 0.35;
      mob.bodyYaw = mob.yaw;
      if (!this.lookLocked) {
        if (mob.headYaw === undefined) mob.headYaw = mob.yaw;
        mob.headYaw += angleDiff(mob.headYaw, yaw) * 0.35;
        if (flying) mob.pitch += (-Math.atan2(dy, Math.max(0.2, dist)) - mob.pitch) * 0.2;
      }
    }
    if (!flying) this.autoJump(dx, dz, dy, dist);
  }

  /** Hops one-block steps and bobs up in fluids. */
  autoJump(dirX, dirZ, dy, dist) {
    const mob = this.mob;
    const w = mob.world;
    if (mob.inWater || mob.inLava) {
      if (dy > 0.05 || mob.horizontalCollision) mob.jumping = true;
      return;
    }
    mob.jumping = false;
    if (!mob.onGround || (mob.jumpCooldown || 0) > 0) return;
    if (dist < 0.15 && dy < 0.5) return;
    const ahead = 0.55 + mob.width * 0.5;
    const bx = Math.floor(mob.x + dirX * ahead);
    const bz = Math.floor(mob.z + dirZ * ahead);
    const fy = Math.floor(mob.y + 0.05);
    const blockedAhead = w.isSolid(bx, fy, bz);
    if (!blockedAhead && dy < 0.55) return;
    // Only jump when the step really is one block and there is headroom.
    const clearOver = !w.isSolid(bx, fy + 1, bz) && !w.isSolid(bx, fy + 2, bz);
    const clearHere = !w.isSolid(Math.floor(mob.x), fy + 2, Math.floor(mob.z));
    if (!clearOver || !clearHere) return;
    this.jump();
  }

  /** Standing jump through the mob's own hook when it has one. */
  jump() {
    const mob = this.mob;
    if (typeof mob.jump === 'function') { mob.jump(); return; }
    if (!mob.onGround) return;
    mob.vy = 8.4;
    mob.jumpCooldown = 10;
  }

  /** Eases the head (and body) toward a world position. */
  lookAt(x, y, z, speed = 0.35) {
    const mob = this.mob;
    this.lookLocked = true;
    if (typeof mob.lookAtPoint === 'function') { mob.lookAtPoint(x, y, z, speed); return; }
    const dx = x - mob.x, dy = y - (mob.y + (mob.eyeHeight || 1.5)), dz = z - mob.z;
    const yaw = Math.atan2(-dx, dz);
    const pitch = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
    if (mob.headYaw === undefined) mob.headYaw = mob.yaw;
    mob.headYaw += angleDiff(mob.headYaw, yaw) * speed;
    mob.yaw += angleDiff(mob.yaw, yaw) * speed * 0.6;
    mob.pitch += (pitch - mob.pitch) * speed;
    mob.headPitch = mob.pitch;
  }

  /** Notices when a mob has been shoving at the same wall for a while. */
  checkStuck() {
    const mob = this.mob;
    if (++this.stuckTimer < 10) return;
    this.stuckTimer = 0;
    const dx = mob.x - this.lastPosX, dz = mob.z - this.lastPosZ;
    this.lastPosX = mob.x; this.lastPosZ = mob.z;
    if (dx * dx + dz * dz > 0.16) { this.stuckCount = 0; return; }
    if (++this.stuckCount < 2) return;
    this.stuckCount = 0;
    this.path = null;
    this.repathCooldown = 0;
    // Shake loose: a hop plus a random sidestep beats grinding into a corner.
    const r = rngOf(mob);
    const ang = r.next() * Math.PI * 2;
    mob.vx += Math.cos(ang) * 1.5;
    mob.vz += Math.sin(ang) * 1.5;
    if (mob.onGround) this.jump();
  }

  /** True when the navigator has somewhere left to go. */
  hasPath() { return !!(this.path && this.pathIndex < this.path.length); }
}

// ===========================================================================
// Goal implementations
// ===========================================================================

// ---- float ----------------------------------------------------------------

/** Swim upward so land mobs bob at the surface instead of drowning. */
class FloatGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 0;
    this.mutex = MUTEX_JUMP;
  }
  canStart() {
    const m = this.mob;
    if (m.waterMob && !this.def.amphibious) return false;
    return (m.inWater && (m.submerged || m.waterDepth > 0.35)) || m.inLava;
  }
  canContinue() { return this.canStart(); }
  start() { this.mob.fallDistance = 0; }
  tick() {
    const m = this.mob;
    m.jumping = true;
    m.fallDistance = 0;
    // A little extra kick in lava, which is thick enough to sink in.
    if (m.inLava && m.vy < 1.2) m.vy += 0.4;
  }
  stop() { this.mob.jumping = false; }
}
defineGoal('float', (mob, args) => new FloatGoal(mob, args));

// ---- wander ---------------------------------------------------------------

/** Strolls to a random reachable spot, preferring open ground. */
class WanderGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 7;
    this.mutex = MUTEX_MOVE;
    this.speed = args.speed || 1;
    this.radius = args.radius || 10;
    this.interval = args.interval || 90;
    this.dest = null;
    this.ticks = 0;
  }
  canStart() {
    const m = this.mob;
    if (m.sitting || (m.leashedTo && distXZ(m, m.leashedTo) > 6)) return false;
    if (this.ai && this.ai.target && this.def.category === 'hostile') return false;
    if (this.rng.int(this.interval) !== 0) return false;
    this.dest = randomReachablePoint(this.world, m, this.radius);
    return !!this.dest;
  }
  start() { this.ticks = 0; }
  canContinue() {
    if (!this.dest) return false;
    if (++this.ticks > 220) return false;
    const m = this.mob;
    const dx = this.dest.x - m.x, dz = this.dest.z - m.z;
    return dx * dx + dz * dz > 0.6;
  }
  tick() {
    if (!this.dest) return;
    this.moveTo(this.dest.x, this.dest.y, this.dest.z, this.speed);
  }
  stop() { this.dest = null; this.stopMoving(); }
}
defineGoal('wander', (mob, args) => new WanderGoal(mob, args));

/** Fish and squid drift to a random point inside their water body. */
class SwimWanderGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 7;
    this.mutex = MUTEX_MOVE;
    this.speed = args.speed || 0.9;
    this.dest = null;
    this.ticks = 0;
  }
  canStart() {
    const m = this.mob;
    if (!m.inWater && this.def.waterMob) {
      // Stranded: flop toward the nearest water instead.
      const water = findBlockNear(this.world, m.x, m.y, m.z, 6, (id) => getBlock(id).liquid === 'water');
      if (!water) return false;
      this.dest = { x: water.x + 0.5, y: water.y, z: water.z + 0.5 };
      return true;
    }
    if (this.rng.int(15) !== 0) return false;
    this.dest = randomReachablePoint(this.world, m, 10);
    return !!this.dest;
  }
  start() { this.ticks = 0; }
  canContinue() {
    if (!this.dest || ++this.ticks > 160) return false;
    const m = this.mob;
    const dx = this.dest.x - m.x, dy = this.dest.y - m.y, dz = this.dest.z - m.z;
    return dx * dx + dy * dy + dz * dz > 1.2;
  }
  tick() {
    const m = this.mob;
    const d = this.dest;
    if (!d) return;
    // Swimmers steer in three dimensions directly - no ground path involved.
    let dx = d.x - m.x, dy = (d.y + 0.4) - m.y, dz = d.z - m.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const want = this.ai.speedFor(this.speed);
    dx /= len; dy /= len; dz /= len;
    m.vx += (dx * want - m.vx) * 0.15;
    m.vz += (dz * want - m.vz) * 0.15;
    if (m.inWater) m.vy += (dy * want * 0.7 - m.vy) * 0.15;
    this.lookAt(d.x, d.y + 0.4, d.z, 0.25);
    this.ai.moveRequested = true;
  }
  stop() { this.dest = null; }
}
defineGoal('swim_wander', (mob, args) => new SwimWanderGoal(mob, args));

/** Bats, parrots, ghasts and phantoms pick a point in the air and drift to it. */
class FlyWanderGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 7;
    this.mutex = MUTEX_MOVE;
    this.speed = args.speed || 1;
    this.dest = null;
    this.ticks = 0;
  }
  canStart() {
    const m = this.mob;
    if (m.sitting) return false;
    if (this.rng.int(this.dest ? 30 : 12) !== 0) return false;
    const w = this.world;
    const r = this.rng;
    for (let i = 0; i < 10; i++) {
      const x = Math.floor(m.x + (r.next() - 0.5) * 16);
      const z = Math.floor(m.z + (r.next() - 0.5) * 16);
      const y = clamp(Math.floor(m.y + (r.next() - 0.35) * 10), 2, WORLD_HEIGHT - 3);
      if (w.isSolid(x, y, z) || w.isSolid(x, y + 1, z)) continue;
      // Stay a couple of blocks off the floor so they do not scrape along it.
      if (!w.isSolid(x, y - 1, z) || this.def.name === 'bat' || this.def.name === 'phantom') {
        this.dest = { x: x + 0.5, y, z: z + 0.5 };
        return true;
      }
    }
    return false;
  }
  start() { this.ticks = 0; }
  canContinue() {
    if (!this.dest || ++this.ticks > 200) return false;
    const m = this.mob;
    const dx = this.dest.x - m.x, dy = this.dest.y - m.y, dz = this.dest.z - m.z;
    return dx * dx + dy * dy + dz * dz > 1.5;
  }
  tick() {
    const d = this.dest;
    if (!d) return;
    this.ai.moveRequested = true;
    this.ai.steer(d.x, d.y, d.z, this.speed);
  }
  stop() { this.dest = null; }
}
defineGoal('fly_wander', (mob, args) => new FlyWanderGoal(mob, args));

// ---- looking --------------------------------------------------------------

/** Watches the nearest player for a random stretch of time. */
class LookAtPlayerGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 8;
    this.mutex = MUTEX_LOOK;
    this.range = args.range || (this.def.category === 'hostile' ? 8 : 6);
    this.chance = args.chance || 0.02;
    this.watched = null;
    this.ticks = 0;
  }
  canStart() {
    if (this.rng.next() > this.chance) return false;
    const t = this.ai && this.ai.target;
    this.watched = t && isTargetable(t) ? t : this.nearestPlayer(this.range);
    return !!this.watched;
  }
  start() { this.ticks = this.rng.range(40, 100); }
  canContinue() {
    const p = this.watched;
    if (!p || !isTargetable(p)) return false;
    if (this.mob.distanceToSq(p.x, p.y, p.z) > this.range * this.range * 2.25) return false;
    return this.ticks-- > 0;
  }
  tick() { this.lookAtEntity(this.watched, 0.3); }
  stop() { this.watched = null; }
}
defineGoal('look_at_player', (mob, args) => new LookAtPlayerGoal(mob, args));

/** Idle head turns so a standing mob never looks frozen. */
class LookRandomGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 9;
    this.mutex = MUTEX_LOOK;
    this.dx = 0; this.dz = 0; this.dy = 0;
    this.ticks = 0;
  }
  canStart() { return this.rng.int(20) === 0; }
  start() {
    const a = this.rng.next() * Math.PI * 2;
    this.dx = Math.cos(a); this.dz = Math.sin(a);
    this.dy = (this.rng.next() - 0.5) * 2;
    this.ticks = this.rng.range(20, 60);
  }
  canContinue() { return this.ticks-- > 0; }
  tick() {
    const m = this.mob;
    this.lookAt(m.x + this.dx * 6, eyeY(m) + this.dy, m.z + this.dz * 6, 0.15);
  }
}
defineGoal('look_random', (mob, args) => new LookRandomGoal(mob, args));

// ---- fear -----------------------------------------------------------------

/** Runs from whatever just hurt it, and towards water when on fire. */
class PanicGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 1;
    this.mutex = MUTEX_MOVE;
    this.speed = args.speed || 1.5;
    this.dest = null;
    this.ticks = 0;
  }
  canStart() {
    const m = this.mob;
    if (m.sitting) return false;
    const scared = m.panicTicks > 0 || m.fireTicks > 0 ||
      (m.lastHurtByTicks > 0 && (this.def.category === 'passive' || this.def.category === 'ambient'));
    if (!scared) return false;
    return this.pickDestination();
  }
  /** On fire? Head for water. Otherwise put distance between us and the source. */
  pickDestination() {
    const m = this.mob;
    const w = this.world;
    if (m.fireTicks > 0) {
      const water = findBlockNear(w, m.x, m.y, m.z, 5, (id) => getBlock(id).liquid === 'water');
      if (water) { this.dest = { x: water.x + 0.5, y: water.y, z: water.z + 0.5 }; return true; }
    }
    const src = m.lastHurtBy;
    const p = src ? fleePoint(w, m, src.x, src.z, 12) : randomReachablePoint(w, m, 10);
    if (!p) return false;
    this.dest = p;
    return true;
  }
  start() { this.ticks = 0; if (this.mob.panicTicks <= 0) this.mob.panicTicks = 60; }
  canContinue() {
    const m = this.mob;
    if (++this.ticks > 200) return false;
    if (m.fireTicks <= 0 && m.panicTicks <= 0) return false;
    if (!this.dest) return false;
    const dx = this.dest.x - m.x, dz = this.dest.z - m.z;
    if (dx * dx + dz * dz < 1) return this.pickDestination();
    return true;
  }
  tick() {
    if (!this.dest && !this.pickDestination()) return;
    this.moveTo(this.dest.x, this.dest.y, this.dest.z, this.speed);
    // Repick every couple of seconds so a cornered animal keeps trying.
    if ((this.ticks % 40) === 0) this.pickDestination();
  }
  stop() { this.dest = null; this.stopMoving(); }
}
defineGoal('panic', (mob, args) => new PanicGoal(mob, args));

/** Keeps away from the entity types listed in `def.avoids`. */
class AvoidEntityGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 3;
    this.mutex = MUTEX_MOVE;
    this.types = args.params || this.def.avoids || [];
    this.range = args.range || 8;
    this.speed = args.speed || 1.4;
    this.threat = null;
    this.dest = null;
  }
  canStart() {
    const types = this.types;
    if (!types || !types.length) return false;
    const m = this.mob;
    const w = this.world;
    if (!w || !w.entitiesNear) return false;
    const near = w.entitiesNear(m.x, m.y, m.z, this.range,
      (e) => e !== m && types.indexOf(e.type) >= 0 && isTargetable(e));
    if (!near.length) return false;
    // Nearest threat first.
    let best = near[0], bestD = m.distanceToSq(best.x, best.y, best.z);
    for (let i = 1; i < near.length; i++) {
      const d = m.distanceToSq(near[i].x, near[i].y, near[i].z);
      if (d < bestD) { bestD = d; best = near[i]; }
    }
    this.threat = best;
    this.dest = fleePoint(w, m, best.x, best.z, 14);
    return !!this.dest;
  }
  canContinue() {
    if (!this.threat || this.threat.removed || !this.dest) return false;
    const m = this.mob;
    if (m.distanceToSq(this.threat.x, this.threat.y, this.threat.z) > this.range * this.range * 2.25) return false;
    const dx = this.dest.x - m.x, dz = this.dest.z - m.z;
    return dx * dx + dz * dz > 1;
  }
  tick() {
    const m = this.mob;
    if (!this.threat || !this.dest) return;
    const close = m.distanceToSq(this.threat.x, this.threat.y, this.threat.z) < 49;
    this.moveTo(this.dest.x, this.dest.y, this.dest.z, close ? this.speed : this.speed * 0.75);
  }
  stop() { this.threat = null; this.dest = null; this.stopMoving(); }
}
defineGoal('avoid_entity', (mob, args) => new AvoidEntityGoal(mob, args));

// ---- melee ----------------------------------------------------------------

/** Squared distance at which a mob's fist connects, vanilla formula. */
function meleeReachSq(mob, target) {
  const w = mob.width * 2;
  return w * w + (target.width || 0.6) + (defOf(mob).attackReach || 0);
}

/** Closes on the target, swings on cooldown and circles at reach. */
class AttackMeleeGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 4;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.speed = args.speed || 1;
    this.strafeDir = 1;
    this.strafeTicks = 0;
    this.seenTicks = 0;
    this.repathTimer = 0;
  }
  canStart() {
    const t = this.target;
    if (!t || !isTargetable(t) || peaceful()) return false;
    if (this.mob.sitting) return false;
    if (this.def.damage <= 0 && !this.def.onAttack) return false;
    return this.mob.distanceToSq(t.x, t.y, t.z) < this.mob.followRange * this.mob.followRange * 2.25;
  }
  canContinue() { return this.canStart(); }
  start() { this.strafeTicks = this.rng.range(40, 100); this.seenTicks = 0; }
  tick() {
    const m = this.mob;
    const t = this.target;
    if (!t) return;
    this.lookAtEntity(t, 0.4);
    const distSq = m.distanceToSq(t.x, t.y, t.z);
    const reachSq = meleeReachSq(m, t);
    const sees = m.canSee ? m.canSee(t) : canSee(this.world, m, t);
    if (sees) this.seenTicks++; else this.seenTicks = 0;

    if (distSq <= reachSq && (m.attackCooldown || 0) <= 0) {
      if (typeof m.attack === 'function') m.attack(t);
      else if (t.hurt) t.hurt(this.def.damage || 2, srcOf('mob', m, m));
    }

    if (distSq > reachSq * 0.85) {
      // Chase. When the target is out of sight, keep heading for its last
      // known position rather than freezing in place.
      if (sees || this.seenTicks === 0) this.moveTo(t.x, t.y, t.z, this.speed);
      else this.moveTo(t.x, t.y, t.z, this.speed * 0.9);
    } else if (this.def.category !== 'passive') {
      // In range: sidestep so two mobs do not stack on the same tile.
      if (--this.strafeTicks <= 0) { this.strafeDir = -this.strafeDir; this.strafeTicks = this.rng.range(30, 80); }
      const dx = t.x - m.x, dz = t.z - m.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const sx = (-dz / len) * this.strafeDir, sz = (dx / len) * this.strafeDir;
      const want = this.ai.speedFor(this.speed * 0.45);
      if (m.onGround) { m.vx = sx * want; m.vz = sz * want; }
      this.ai.moveRequested = true;
    }
  }
  stop() { this.stopMoving(); }
}
defineGoal('attack_melee', (mob, args) => new AttackMeleeGoal(mob, args));

/** Spiders and other pouncers hurl themselves at a target a few blocks away. */
class LeapAtTargetGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 3;
    this.mutex = MUTEX_MOVE | MUTEX_JUMP;
    this.power = args.power || 0.4;
  }
  canStart() {
    const m = this.mob;
    const t = this.target;
    if (!t || !isTargetable(t) || m.baby || !m.onGround) return false;
    const d = m.distanceToSq(t.x, t.y, t.z);
    if (d < 4 || d > 16) return false;
    if (!(m.canSee ? m.canSee(t) : canSee(this.world, m, t))) return false;
    return this.rng.int(5) === 0;
  }
  canContinue() { return !this.mob.onGround; }
  start() {
    const m = this.mob, t = this.target;
    let dx = t.x - m.x, dz = t.z - m.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.01) return;
    dx /= len; dz /= len;
    m.vx = m.vx * 0.2 + dx * 7.5 * this.power * 2;
    m.vz = m.vz * 0.2 + dz * 7.5 * this.power * 2;
    m.vy = 6.6;
    m.jumpCooldown = 10;
  }
}
defineGoal('leap_at_target', (mob, args) => new LeapAtTargetGoal(mob, args));

// ---- ranged ---------------------------------------------------------------

/** Shared strafing logic for anything that prefers to fight at a distance. */
class RangedGoalBase extends Goal {
  constructor(mob, args, range, interval) {
    super(mob, args);
    this.priority = 4;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.range = args.range || this.def.rangedRange || range;
    this.interval = args.interval || this.def.attackInterval || interval;
    this.speed = args.speed || 1;
    this.cooldown = 0;
    this.strafeDir = 1;
    this.strafeTicks = 0;
    this.seenTicks = 0;
  }
  canStart() {
    if (peaceful() || this.mob.sitting) return false;
    const t = this.target;
    return !!(t && isTargetable(t));
  }
  canContinue() { return this.canStart(); }
  start() { this.cooldown = this.rng.range(10, this.interval); this.strafeTicks = this.rng.range(30, 80); }
  stop() { this.seenTicks = 0; this.stopMoving(); }
  /** Backs off when crowded, closes when far, and sidesteps in between. */
  reposition(dist, sees) {
    const m = this.mob;
    const t = this.target;
    const near = this.range * 0.4;
    if (!sees || dist > this.range * 0.9) {
      this.moveTo(t.x, t.y, t.z, this.speed);
      return;
    }
    if (dist < near) {
      const p = fleePoint(this.world, m, t.x, t.z, 8);
      if (p) { this.moveTo(p.x, p.y, p.z, this.speed * 1.1); return; }
    }
    if (--this.strafeTicks <= 0) { this.strafeDir = -this.strafeDir; this.strafeTicks = this.rng.range(30, 80); }
    const dx = t.x - m.x, dz = t.z - m.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const sx = (-dz / len) * this.strafeDir, sz = (dx / len) * this.strafeDir;
    const want = this.ai.speedFor(this.speed * 0.5);
    if (m.onGround) { m.vx = sx * want; m.vz = sz * want; }
    this.ai.moveRequested = true;
  }
}

/** Generic projectile attacker driven by the definition's `ranged` hook. */
class AttackRangedGoal extends RangedGoalBase {
  constructor(mob, args) { super(mob, args, 15, 40); }
  canStart() {
    if (!super.canStart()) return false;
    return !!(this.def.ranged || this.def.projectile);
  }
  tick() {
    const m = this.mob;
    const t = this.target;
    this.lookAtEntity(t, 0.5);
    const dist = Math.sqrt(m.distanceToSq(t.x, t.y, t.z));
    const sees = m.canSee ? m.canSee(t) : canSee(this.world, m, t);
    if (sees) this.seenTicks++; else this.seenTicks = 0;
    this.reposition(dist, sees);
    if (this.cooldown > 0) { this.cooldown--; return; }
    if (!sees || dist > this.range) return;
    this.cooldown = this.interval;
    if (typeof m.rangedAttack === 'function' && this.def.ranged) m.rangedAttack(t, clamp(dist / this.range, 0.1, 1));
    else this.fireFallback(t, dist);
  }
  /** Used when the mob has no `ranged` hook but names a projectile type. */
  fireFallback(t, dist) {
    const m = this.mob;
    const type = this.def.projectile || 'arrow';
    const dx = t.x - m.x;
    const dy = (eyeY(t) - 0.1) - eyeY(m);
    const dz = t.z - m.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    shoot(type, this.world, m, m.x, eyeY(m) - 0.1, m.z,
      dx / len, dy / len + dist * 0.006, dz / len, { damage: this.def.damage || 2 });
    playAt(this.world, 'arrow_shoot', m.x, m.y, m.z, 1, 1);
  }
}
defineGoal('attack_ranged', (mob, args) => new AttackRangedGoal(mob, args));

/** Skeleton archery: draw, lead the shot, back off and strafe. */
class AttackBowGoal extends RangedGoalBase {
  constructor(mob, args) {
    super(mob, args, 15, 20);
    this.draw = -1;
    this.drawTime = 25;
  }
  start() { super.start(); this.draw = -1; }
  stop() {
    super.stop();
    this.draw = -1;
    this.mob.drawingBow = false;
    this.mob.bowCharge = 0;
    this.mob.aiming = false;
  }
  tick() {
    const m = this.mob;
    const t = this.target;
    this.lookAtEntity(t, 0.55);
    const dist = Math.sqrt(m.distanceToSq(t.x, t.y, t.z));
    const sees = m.canSee ? m.canSee(t) : canSee(this.world, m, t);
    if (sees) this.seenTicks++; else this.seenTicks = 0;
    this.reposition(dist, sees);

    if (!sees || this.seenTicks < 3) {
      this.draw = -1;
      m.drawingBow = false;
      m.bowCharge = 0;
      return;
    }
    if (this.draw < 0) {
      // Difficulty decides how long the draw takes, exactly like vanilla.
      const hard = Game.difficulty === DIFFICULTY.HARD;
      this.draw = 0;
      this.drawTime = hard ? 20 : Game.difficulty === DIFFICULTY.EASY ? 30 : 25;
      m.drawingBow = true;
    }
    this.draw++;
    m.bowCharge = clamp(this.draw / this.drawTime, 0, 1);
    if (this.draw < this.drawTime || dist > this.range) return;

    const power = clamp(this.draw / this.drawTime, 0.1, 1);
    this.fire(t, dist, power);
    this.draw = -1;
    m.drawingBow = false;
    m.bowCharge = 0;
  }
  /** Aims where the target will be, not where it is. */
  fire(t, dist, power) {
    const m = this.mob;
    const flight = dist / 38;                      // arrows travel ~38 blocks/s
    const lead = clamp(flight, 0, 1.2);
    const ax = t.x + (t.vx || 0) * lead;
    const ay = eyeY(t) - 0.25 + (t.vy || 0) * lead * 0.5;
    const az = t.z + (t.vz || 0) * lead;
    m.lookAtPoint?.(ax, ay, az, 1);
    if (typeof m.rangedAttack === 'function' && this.def.ranged) { m.rangedAttack(t, power); return; }
    const dx = ax - m.x, dy = ay - (eyeY(m) - 0.1), dz = az - m.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    shoot('arrow', this.world, m, m.x, eyeY(m) - 0.1, m.z,
      dx / len, dy / len + dist * 0.0055, dz / len, { power, damage: 2 });
    playAt(this.world, 'arrow_shoot', m.x, m.y, m.z, 1, 1 / (this.rng.next() * 0.4 + 0.8));
  }
}
defineGoal('attack_bow', (mob, args) => new AttackBowGoal(mob, args));

/** Ghast and blaze fireballs: charge visibly, then let fly. */
class RangedFireballGoal extends RangedGoalBase {
  constructor(mob, args) {
    super(mob, args, 24, 60);
    this.charge = 0;
    this.chargeTime = args.chargeTime || this.def.chargeTime || 20;
    this.burst = args.burst || this.def.burst || 1;
    this.fired = 0;
  }
  start() { super.start(); this.charge = 0; this.fired = 0; }
  stop() { super.stop(); this.charge = 0; this.mob.charging = false; this.mob.chargeTicks = 0; }
  tick() {
    const m = this.mob;
    const t = this.target;
    this.lookAtEntity(t, 0.6);
    const dist = Math.sqrt(m.distanceToSq(t.x, t.y, t.z));
    const sees = m.canSee ? m.canSee(t) : canSee(this.world, m, t);
    const flying = !!(this.def.flying || m.flyingMob);
    if (!flying) this.reposition(dist, sees);
    else if (dist > this.range) { this.moveTo(t.x, t.y + 3, t.z, this.speed); }
    else if (dist < this.range * 0.35) {
      const p = fleePoint(this.world, m, t.x, t.z, 10);
      if (p) this.moveTo(p.x, m.y + 2, p.z, this.speed);
    } else this.ai.moveRequested = true;

    if (!sees || dist > this.range) { this.charge = Math.max(0, this.charge - 2); m.charging = false; return; }
    if (this.cooldown > 0) { this.cooldown--; return; }
    this.charge++;
    m.charging = true;
    m.chargeTicks = this.charge;
    if (this.charge === 1) playAt(this.world, 'ghast_charge', m.x, m.y, m.z, 2, 1);
    if (this.charge < this.chargeTime) return;
    this.charge = 0;
    m.charging = false;
    m.chargeTicks = 0;
    this.fireOne(t);
    if (++this.fired >= this.burst) { this.fired = 0; this.cooldown = this.interval; }
    else this.cooldown = 6;
  }
  /** One fireball toward the target, using the mob's own hook when present. */
  fireOne(t) {
    const m = this.mob;
    if (typeof m.rangedAttack === 'function' && this.def.ranged) { m.rangedAttack(t, 1); return; }
    const type = this.def.projectile || (this.def.name === 'ghast' ? 'fireball' : 'small_fireball');
    const dx = t.x - m.x, dy = eyeY(t) - eyeY(m), dz = t.z - m.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    shoot(type, this.world, m, m.x, eyeY(m), m.z, dx / len, dy / len, dz / len, { explosionPower: 1 });
    playAt(this.world, 'ghast_shoot', m.x, m.y, m.z, 2, 1);
  }
}
defineGoal('ranged_fireball', (mob, args) => new RangedFireballGoal(mob, args));

/** Creepers walk in, stop, and let their definition run the fuse. */
class CreeperSwellGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 2;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.speed = args.speed || 1;
    this.ownFuse = 0;
  }
  canStart() {
    const t = this.target;
    if (!t || !isTargetable(t) || peaceful()) return false;
    return this.mob.distanceToSq(t.x, t.y, t.z) < 256 || this.mob.ignited;
  }
  canContinue() { return this.canStart(); }
  start() { this.ownFuse = 0; }
  tick() {
    const m = this.mob;
    const t = this.target;
    this.lookAtEntity(t, 0.5);
    const dist = Math.sqrt(m.distanceToSq(t.x, t.y, t.z));
    const sees = m.canSee ? m.canSee(t) : canSee(this.world, m, t);
    const armed = m.ignited || (dist < 3 && sees);
    if (!armed) this.moveTo(t.x, t.y, t.z, this.speed);
    else this.ai.moveRequested = true;   // hold still while swelling
    // The creeper definition owns `fuse`; only run our own timer when the
    // species does not (a modded creeper-alike without the hook).
    if (typeof m.fuse === 'number') return;
    if (!armed) { this.ownFuse = Math.max(0, this.ownFuse - 1); m.swell = this.ownFuse / 30; return; }
    this.ownFuse++;
    m.swell = clamp(this.ownFuse / 30, 0, 1);
    if (this.ownFuse === 1) playAt(this.world, 'creeper_hiss', m.x, m.y, m.z, 1, 0.5);
    if (this.ownFuse >= 30 && typeof m.explodeSelf === 'function') m.explodeSelf(m.charged ? 6 : 3);
  }
  stop() { this.ownFuse = 0; this.stopMoving(); }
}
defineGoal('creeper_swell', (mob, args) => new CreeperSwellGoal(mob, args));

// ---- target selection -----------------------------------------------------

/** Fights back against whatever hit it, and calls in nearby friends. */
class HurtByTargetGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 1;
    this.mutex = MUTEX_TARGET;
    this.alertRange = args.alertRange || (this.def.alertRange ?? 10);
    this.seen = null;
  }
  canStart() {
    const m = this.mob;
    const by = m.lastHurtBy;
    if (!by || m.lastHurtByTicks <= 0 || !isTargetable(by)) return false;
    if (by === m || by === m.owner) return false;
    if (typeof m.shouldRetaliate === 'function' && !m.shouldRetaliate(by)) return false;
    return by !== this.seen || this.ai.target !== by;
  }
  start() {
    const m = this.mob;
    const by = m.lastHurtBy;
    this.seen = by;
    this.setTarget(by);
    m.angry = true;
    if (m.angerTicks !== undefined && m.angerTicks < 200) m.angerTicks = this.rng.range(400, 800);
    this.alertOthers(by);
  }
  /** Neutral mobs (wolves, piglins, bees) drag their pack into the fight. */
  alertOthers(attacker) {
    const m = this.mob;
    const w = this.world;
    if (!w || !w.entitiesNear || this.alertRange <= 0) return;
    const near = w.entitiesNear(m.x, m.y, m.z, this.alertRange,
      (e) => e !== m && e.isMob && e.type === m.type && !e.target && !e.baby);
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.tamed && o.owner === attacker) continue;
      if (typeof o.setTarget === 'function') o.setTarget(attacker);
      o.angry = true;
      if (o.angerTicks !== undefined) o.angerTicks = 400;
    }
  }
  canContinue() {
    const t = this.ai.target;
    if (!t || !isTargetable(t)) return false;
    return this.mob.lastHurtByTicks > 0 || this.mob.angerTicks > 0;
  }
  stop() { this.seen = null; }
}
defineGoal('hurt_by_target', (mob, args) => new HurtByTargetGoal(mob, args));

/** Scans for anything on the definition's target list and locks on. */
class NearestAttackableTargetGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 2;
    this.mutex = MUTEX_TARGET;
    this.types = args.params || this.def.targets || ['player'];
    this.interval = args.interval || 10;
    this.requireSight = args.sight !== false;
    this.found = null;
  }
  /** True when this mob is allowed to hunt `e` at all. */
  wants(e) {
    const m = this.mob;
    if (e === m || !isTargetable(e)) return false;
    if (e === m.owner || (m.tamed && e === m.owner)) return false;
    if (e.isPlayer || e.type === 'player') {
      if (this.types.indexOf('player') < 0) return false;
      if (e.hasEffect && e.hasEffect('invisibility') && this.rng.next() < 0.7) return false;
    } else if (this.types.indexOf(e.type) < 0) return false;
    if (e.isMob && e.tamed && this.def.category !== 'hostile') return false;
    return true;
  }
  canStart() {
    const m = this.mob;
    if (peaceful() && this.types.indexOf('player') >= 0 && this.def.category === 'hostile') return false;
    if (m.sitting) return false;
    if (this.def.category === 'neutral' && !m.angry) return false;
    if (this.ai.target && isTargetable(this.ai.target)) return false;
    if ((this.ai.tickCount % this.interval) !== 0) return false;
    const w = this.world;
    if (!w || !w.entitiesNear) return false;
    const range = m.followRange || 16;
    const near = w.entitiesNear(m.x, m.y, m.z, range, (e) => this.wants(e));
    let best = null, bestD = range * range;
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      const d = m.distanceToSq(e.x, e.y, e.z);
      if (d >= bestD) continue;
      if (this.requireSight && !(m.canSee ? m.canSee(e) : canSee(w, m, e))) continue;
      bestD = d; best = e;
    }
    this.found = best;
    return !!best;
  }
  start() { this.setTarget(this.found); }
  canContinue() {
    const m = this.mob;
    const t = this.ai.target;
    if (!t || !isTargetable(t)) return false;
    const range = (m.followRange || 16) * 1.5;
    return m.distanceToSq(t.x, t.y, t.z) < range * range;
  }
  stop() { this.found = null; if (!isTargetable(this.ai.target)) this.setTarget(null); }
}
defineGoal('nearest_attackable_target', (mob, args) => new NearestAttackableTargetGoal(mob, args));

/** Iron golems: hunt anything hostile that comes near the villagers. */
class DefendVillageGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 1;
    this.mutex = MUTEX_TARGET;
    this.range = args.range || 16;
    this.found = null;
  }
  canStart() {
    const m = this.mob;
    const w = this.world;
    if (!w || !w.entitiesNear) return false;
    if (this.ai.target && isTargetable(this.ai.target)) return false;
    if ((this.ai.tickCount % 20) !== 0) return false;
    const friends = w.entitiesNear(m.x, m.y, m.z, this.range,
      (e) => e.type === 'villager' || e.type === 'iron_golem' || e.isPlayer || e.type === 'player');
    if (!friends.length) return false;
    // Whoever is currently beating on a villager gets priority.
    for (let i = 0; i < friends.length; i++) {
      const f = friends[i];
      const by = f.lastHurtBy;
      if (by && f.lastHurtByTicks > 0 && isTargetable(by) && by !== m && by.type !== 'villager' && !by.isPlayer) {
        this.found = by;
        return true;
      }
    }
    const hostiles = w.entitiesNear(m.x, m.y, m.z, this.range, (e) => {
      if (!isTargetable(e) || !e.isMob) return false;
      const c = defOf(e).category;
      if (c !== 'hostile' && !defOf(e).illager) return false;
      return e.type !== 'creeper';   // golems refuse to pop creepers next to homes
    });
    let best = null, bestD = Infinity;
    for (let i = 0; i < hostiles.length; i++) {
      for (let j = 0; j < friends.length; j++) {
        const d = hostiles[i].distanceToSq(friends[j].x, friends[j].y, friends[j].z);
        if (d < 144 && d < bestD) { bestD = d; best = hostiles[i]; }
      }
    }
    this.found = best;
    return !!best;
  }
  start() { this.setTarget(this.found); this.mob.angry = true; }
  canContinue() { return !!(this.ai.target && isTargetable(this.ai.target)); }
  stop() { this.found = null; }
}
defineGoal('defend_village', (mob, args) => new DefendVillageGoal(mob, args));

/** Endermen hold a dead-eyed stare at whoever provoked them. */
class StareAggroGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 2;
    this.mutex = MUTEX_LOOK | MUTEX_TARGET;
    this.ticks = 0;
  }
  canStart() {
    const t = this.ai.target;
    return !!(t && isTargetable(t) && this.mob.distanceToSq(t.x, t.y, t.z) < 64 * 64);
  }
  canContinue() { return this.canStart() && this.ticks < 400; }
  start() { this.ticks = 0; this.mob.screaming = true; }
  tick() {
    this.ticks++;
    const t = this.ai.target;
    // A stare pins the head dead-on; the body barely moves.
    this.lookAt(t.x, eyeY(t), t.z, 0.9);
    this.mob.screaming = true;
    if ((this.ticks % 40) === 0) particles('portal', this.mob.x, this.mob.y + this.mob.height * 0.8, this.mob.z, { count: 2, spread: 0.4 });
  }
  stop() { this.mob.screaming = false; }
}
defineGoal('stare_aggro', (mob, args) => new StareAggroGoal(mob, args));

// ---- sunlight -------------------------------------------------------------

/** Burning undead run for the nearest patch of shade. */
class FleeSunGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 3;
    this.mutex = MUTEX_MOVE;
    this.speed = args.speed || 1.2;
    this.dest = null;
  }
  /** Nearest standable block the sky cannot reach. */
  findShade() {
    const m = this.mob;
    const w = this.world;
    const prof = pathProfile(m);
    const ctx = makeCtx(w, prof, Math.floor(m.x), Math.floor(m.z));
    const r = this.rng;
    for (let i = 0; i < 12; i++) {
      const x = Math.floor(m.x + (r.next() - 0.5) * 20);
      const z = Math.floor(m.z + (r.next() - 0.5) * 20);
      const y = groundNear(ctx, x, Math.floor(m.y + 0.02), z, 4);
      if (y === null) continue;
      if (w.canSeeSky && w.canSeeSky(x, y, z)) continue;
      if (ctx.standCost(x, y, z) < 0) continue;
      this.dest = { x: x + 0.5, y, z: z + 0.5 };
      return true;
    }
    return false;
  }
  canStart() {
    const m = this.mob;
    if (!this.def.burnsInDay && !this.def.avoidsSun) return false;
    if (m.hasHelmet && m.hasHelmet()) return false;
    if (this.ai.target && m.fireTicks <= 0) return false;
    if (!(m.isInDaylight ? m.isInDaylight() : false)) return false;
    return this.findShade();
  }
  canContinue() {
    const m = this.mob;
    if (!this.dest) return false;
    if (!(m.isInDaylight ? m.isInDaylight() : false)) return false;
    const dx = this.dest.x - m.x, dz = this.dest.z - m.z;
    return dx * dx + dz * dz > 0.8;
  }
  tick() {
    if (!this.dest && !this.findShade()) return;
    this.moveTo(this.dest.x, this.dest.y, this.dest.z, this.speed);
  }
  stop() { this.dest = null; this.stopMoving(); }
}
defineGoal('flee_sun', (mob, args) => new FleeSunGoal(mob, args));

/**
 * Marks sunlit blocks as expensive while the sun is up, so every other goal's
 * paths naturally hug the shade. Holds no channels of its own.
 */
class RestrictSunGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 2;
    this.mutex = 0;
  }
  canStart() {
    const w = this.world;
    if (!w || w.dimension !== DIM_OVERWORLD) return false;
    if (this.mob.hasHelmet && this.mob.hasHelmet()) return false;
    return !!(w.isDay && w.isDay());
  }
  canContinue() { return this.canStart(); }
  start() { this.mob._avoidSun = true; }
  stop() { this.mob._avoidSun = false; }
}
defineGoal('restrict_sun', (mob, args) => new RestrictSunGoal(mob, args));

// ---- doors ----------------------------------------------------------------

/** Finds a door-like block right in front of the mob, or null. */
function doorInFront(mob, world, wooden) {
  const yaw = mob.yaw;
  const fx = -Math.sin(yaw), fz = Math.cos(yaw);
  const fy = Math.floor(mob.y + 0.05);
  for (let step = 1; step <= 2; step++) {
    const x = Math.floor(mob.x + fx * step * 0.75);
    const z = Math.floor(mob.z + fz * step * 0.75);
    for (let dy = 0; dy <= 1; dy++) {
      const y = fy + dy;
      const raw = world.getRaw(x, y, z);
      const def = getBlock(raw & ID_MASK);
      if (!isDoorLike(def) || def.model === 'trapdoor') continue;
      if (wooden && (def.name === 'iron_door' || def.name === 'iron_trapdoor')) continue;
      return { x, y, z, def, meta: (raw >>> 12) & 15 };
    }
  }
  return null;
}

/** Flips the open bit on a door (both halves) or a fence gate. */
function setDoorOpen(world, x, y, z, def, meta, open) {
  const bit = def.model === 'door' ? 8 : 4;
  const next = open ? (meta | bit) : (meta & ~bit);
  if (next === meta) return false;
  world.setBlock(x, y, z, def.id, next, 3);
  if (def.model === 'door') {
    // Doors are two blocks: keep the other half in sync.
    const otherY = (meta & 1) ? y - 1 : y + 1;
    const raw = world.getRaw(x, otherY, z);
    const od = getBlock(raw & ID_MASK);
    if (od.model === 'door') {
      const om = (raw >>> 12) & 15;
      world.setBlock(x, otherY, z, od.id, open ? (om | 8) : (om & ~8), 3);
    }
  }
  return true;
}

/** Villagers and piglins push doors open, then pull them shut behind them. */
class OpenDoorGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 2;
    this.mutex = 0;              // opening a door does not stop walking
    this.door = null;
    this.closeAfter = args.close !== false;
    this.timer = 0;
  }
  canStart() {
    const m = this.mob;
    // Only bother when the mob is actually going somewhere.
    const moving = this.ai.hasPath() || this.ai.movedLastTick ||
      (m.vx * m.vx + m.vz * m.vz) > 0.04;
    if (!moving) return false;
    const d = doorInFront(m, this.world, true);
    if (!d) return false;
    if (isDoorOpen(d.def, d.meta)) return false;
    this.door = d;
    return true;
  }
  start() {
    const d = this.door;
    if (!d) return;
    if (setDoorOpen(this.world, d.x, d.y, d.z, d.def, d.meta, true)) {
      playAt(this.world, d.def.model === 'door' ? 'door_open' : 'fence_gate_open', d.x + 0.5, d.y + 0.5, d.z + 0.5, 1, 1);
    }
    this.timer = 0;
  }
  canContinue() { return this.closeAfter && this.door !== null && this.timer < 120; }
  tick() {
    this.timer++;
    const m = this.mob;
    const d = this.door;
    if (!d) return;
    const dx = m.x - (d.x + 0.5), dz = m.z - (d.z + 0.5);
    if (dx * dx + dz * dz > 4) this.timer = 120;   // through it: shut on stop()
  }
  stop() {
    const d = this.door;
    this.door = null;
    if (!d || !this.closeAfter) return;
    const raw = this.world.getRaw(d.x, d.y, d.z);
    const def = getBlock(raw & ID_MASK);
    if (def.id !== d.def.id) return;               // somebody changed it: leave it be
    if (setDoorOpen(this.world, d.x, d.y, d.z, def, (raw >>> 12) & 15, false)) {
      playAt(this.world, def.model === 'door' ? 'door_close' : 'fence_gate_close', d.x + 0.5, d.y + 0.5, d.z + 0.5, 1, 1);
    }
  }
}
defineGoal('open_door', (mob, args) => new OpenDoorGoal(mob, args));

/** Zombies chew through wooden doors when the difficulty allows it. */
class BreakDoorGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 1;
    this.mutex = MUTEX_MOVE;
    this.door = null;
    this.progress = 0;
    this.duration = 240;
  }
  canStart() {
    const m = this.mob;
    if (Game.difficulty !== DIFFICULTY.HARD && Game.difficulty !== DIFFICULTY.NORMAL) return false;
    if (Game.world?.gameRules?.mobGriefing === false) return false;
    if (!this.ai.target) return false;
    const d = doorInFront(m, this.world, true);
    if (!d || d.def.model !== 'door') return false;
    if (isDoorOpen(d.def, d.meta)) return false;
    this.door = d;
    return true;
  }
  start() {
    this.progress = 0;
    this.duration = Game.difficulty === DIFFICULTY.HARD ? 240 : 480;
  }
  canContinue() {
    if (!this.door || !this.ai.target) return false;
    const raw = this.world.getRaw(this.door.x, this.door.y, this.door.z);
    if (getBlock(raw & ID_MASK).id !== this.door.def.id) return false;
    return this.progress <= this.duration;
  }
  tick() {
    const m = this.mob;
    const d = this.door;
    if (!d) return;
    this.progress++;
    m.doorBreakProgress = this.progress / this.duration;
    this.lookAt(d.x + 0.5, d.y + 0.5, d.z + 0.5, 0.3);
    this.ai.moveRequested = true;
    if (this.rng.next() < 0.08) {
      playAt(this.world, 'zombie_attack_door', d.x + 0.5, d.y + 0.5, d.z + 0.5, 1, 1);
      particles('block', d.x + 0.5, d.y + 0.5, d.z + 0.5, { count: 4, spread: 0.4, block: d.def.name });
    }
    if (this.progress < this.duration) return;
    // Both halves come down together.
    const otherY = (d.meta & 1) ? d.y - 1 : d.y + 1;
    this.world.setBlock(d.x, d.y, d.z, 0, 0, 3);
    if (getBlock(this.world.getBlock(d.x, otherY, d.z)).model === 'door') {
      this.world.setBlock(d.x, otherY, d.z, 0, 0, 3);
    }
    playAt(this.world, 'door_break', d.x + 0.5, d.y + 0.5, d.z + 0.5, 1, 1);
    this.door = null;
  }
  stop() { this.progress = 0; this.mob.doorBreakProgress = 0; this.door = null; }
}
defineGoal('break_door', (mob, args) => new BreakDoorGoal(mob, args));

// ---- husbandry and pets ---------------------------------------------------

/** Tamed pets trail their owner and blink to them when left behind. */
class FollowOwnerGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 6;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.speed = args.speed || 1.1;
    this.startDist = args.start || 10;
    this.stopDist = args.stop || 2.5;
    this.teleportDist = args.teleport || 14;
    this.owner = null;
  }
  canStart() {
    const m = this.mob;
    if (!m.tamed || m.sitting) return false;
    const o = m.owner;
    if (!o || o.removed || o.dead) return false;
    this.owner = o;
    return m.distanceToSq(o.x, o.y, o.z) > this.startDist * this.startDist;
  }
  canContinue() {
    const m = this.mob;
    const o = this.owner;
    if (!o || o.removed || m.sitting) return false;
    return m.distanceToSq(o.x, o.y, o.z) > this.stopDist * this.stopDist;
  }
  tick() {
    const m = this.mob;
    const o = this.owner || (this.owner = m.owner);
    if (!o) return;
    this.lookAtEntity(o, 0.3);
    const d = Math.sqrt(m.distanceToSq(o.x, o.y, o.z));
    if (d > this.teleportDist && this.tryTeleport()) return;
    this.moveTo(o.x, o.y, o.z, d > this.startDist * 1.5 ? this.speed * 1.3 : this.speed);
  }
  /** Blinks to a free block near the owner, like a vanilla wolf. */
  tryTeleport() {
    const m = this.mob;
    const o = this.owner;
    const w = this.world;
    const prof = pathProfile(m);
    const ctx = makeCtx(w, prof, Math.floor(o.x), Math.floor(o.z));
    const r = this.rng;
    for (let i = 0; i < 12; i++) {
      const x = Math.floor(o.x) + r.range(-3, 3);
      const z = Math.floor(o.z) + r.range(-3, 3);
      const y = groundNear(ctx, x, Math.floor(o.y), z, 3);
      if (y === null || ctx.standCost(x, y, z) < 0) continue;
      if (Math.abs(x - o.x) < 1 && Math.abs(z - o.z) < 1) continue;
      m.setPosition ? m.setPosition(x + 0.5, y, z + 0.5) : (m.x = x + 0.5, m.y = y, m.z = z + 0.5);
      m.vx = m.vy = m.vz = 0;
      m.fallDistance = 0;
      if (this.ai) this.ai.stopMoving();
      return true;
    }
    return false;
  }
  stop() { this.owner = null; this.stopMoving(); }
}
defineGoal('follow_owner', (mob, args) => new FollowOwnerGoal(mob, args));

/** Babies keep close to the nearest adult of their own kind. */
class FollowParentGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 6;
    this.mutex = MUTEX_MOVE;
    this.speed = args.speed || 1.1;
    this.parent = null;
    this.timer = 0;
  }
  findParent() {
    const m = this.mob;
    const w = this.world;
    if (!w || !w.entitiesNear) return null;
    const near = w.entitiesNear(m.x, m.y, m.z, 8, (e) => e !== m && e.isMob && e.type === m.type && !e.baby);
    let best = null, bestD = 64;
    for (let i = 0; i < near.length; i++) {
      const d = m.distanceToSq(near[i].x, near[i].y, near[i].z);
      if (d < bestD) { bestD = d; best = near[i]; }
    }
    return best;
  }
  canStart() {
    const m = this.mob;
    if (!m.baby) return false;
    if (m.parent && !m.parent.removed && m.distanceToSq(m.parent.x, m.parent.y, m.parent.z) < 144) this.parent = m.parent;
    else this.parent = this.findParent();
    if (!this.parent) return false;
    return m.distanceToSq(this.parent.x, this.parent.y, this.parent.z) > 9;
  }
  start() { this.timer = 0; }
  canContinue() {
    const m = this.mob;
    const p = this.parent;
    if (!m.baby || !p || p.removed || ++this.timer > 400) return false;
    const d = m.distanceToSq(p.x, p.y, p.z);
    return d > 4 && d < 256;
  }
  tick() {
    const p = this.parent;
    if (!p) return;
    this.moveTo(p.x, p.y, p.z, this.speed);
  }
  stop() { this.parent = null; this.stopMoving(); }
}
defineGoal('follow_parent', (mob, args) => new FollowParentGoal(mob, args));

/** True when a stack is one of the items this mob will follow. */
function isTemptItem(def, stack) {
  if (!stack || !stack.item) return false;
  const list = def.tempts || def.breedItems || def.tameItems;
  return !!(list && list.indexOf(stack.item) >= 0);
}

/** Trots after a player holding the right food, stopping just short. */
class TemptGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 5;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.speed = args.speed || 1.1;
    this.range = args.range || 10;
    this.player = null;
    this.cooldown = 0;
    this.offset = 0;
  }
  /** The held stack of a player, main hand first. */
  heldOf(p) {
    if (typeof p.getHeldItem === 'function') {
      const s = p.getHeldItem();
      if (isTemptItem(this.def, s)) return s;
    }
    if (typeof p.getOffhandItem === 'function') {
      const s = p.getOffhandItem();
      if (isTemptItem(this.def, s)) return s;
    }
    return null;
  }
  canStart() {
    const m = this.mob;
    if (m.sitting) return false;
    if (this.cooldown > 0) { this.cooldown--; return false; }
    const w = this.world;
    if (!w || !w.getPlayers) return false;
    const players = w.getPlayers();
    let best = null, bestD = this.range * this.range;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!isTargetable(p) || !this.heldOf(p)) continue;
      const d = m.distanceToSq(p.x, p.y, p.z);
      if (d < bestD) { bestD = d; best = p; }
    }
    this.player = best;
    return !!best;
  }
  start() {
    this.mob.tempted = true;
    this.mob.temptedBy = this.player;
    // Stand a little off to one side so a herd does not pile onto the player.
    this.offset = (this.rng.next() - 0.5) * 1.6;
  }
  canContinue() {
    const p = this.player;
    if (!p || !isTargetable(p) || !this.heldOf(p)) return false;
    return this.mob.distanceToSq(p.x, p.y, p.z) < this.range * this.range * 2.25;
  }
  tick() {
    const m = this.mob;
    const p = this.player;
    if (!p) return;
    this.lookAtEntity(p, 0.5);
    const dist = Math.sqrt(m.distanceToSq(p.x, p.y, p.z));
    if (dist < 2.4) { this.ai.moveRequested = true; return; }
    const dx = p.x - m.x, dz = p.z - m.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    this.moveTo(p.x - (dz / len) * this.offset, p.y, p.z + (dx / len) * this.offset, this.speed);
  }
  stop() {
    this.mob.tempted = false;
    this.mob.temptedBy = null;
    this.player = null;
    this.cooldown = 100;
    this.stopMoving();
  }
}
defineGoal('tempt', (mob, args) => new TemptGoal(mob, args));

/** Two animals in love walk together, then make a baby. */
class BreedGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 5;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.speed = args.speed || 1;
    this.partner = null;
    this.ticks = 0;
  }
  findPartner() {
    const m = this.mob;
    const w = this.world;
    if (!w || !w.entitiesNear) return null;
    const near = w.entitiesNear(m.x, m.y, m.z, 8,
      (e) => e !== m && e.isMob && e.type === m.type && e.loveTicks > 0 && !e.baby);
    let best = null, bestD = 64;
    for (let i = 0; i < near.length; i++) {
      const d = m.distanceToSq(near[i].x, near[i].y, near[i].z);
      if (d < bestD) { bestD = d; best = near[i]; }
    }
    return best;
  }
  canStart() {
    const m = this.mob;
    if (m.baby || m.loveTicks <= 0 || m.breedCooldown > 0) return false;
    this.partner = this.findPartner();
    return !!this.partner;
  }
  start() { this.ticks = 0; }
  canContinue() {
    const p = this.partner;
    if (!p || p.removed || p.loveTicks <= 0 || this.mob.loveTicks <= 0) return false;
    return ++this.ticks < 120;
  }
  tick() {
    const m = this.mob;
    const p = this.partner;
    if (!p) return;
    this.lookAtEntity(p, 0.4);
    const dist = Math.sqrt(m.distanceToSq(p.x, p.y, p.z));
    if (dist > 2.5) { this.moveTo(p.x, p.y, p.z, this.speed); return; }
    this.ai.moveRequested = true;
    if (this.ticks < 60) return;
    this.breed(p);
  }
  /** Spawns the baby, resets both love timers and scatters the XP. */
  breed(p) {
    const m = this.mob;
    if (typeof m.breedWith === 'function') { m.breedWith(p); this.partner = null; return; }
    m.loveTicks = 0; p.loveTicks = 0;
    m.breedCooldown = 6000; p.breedCooldown = 6000;
    dropXp(this.world, m.x, m.y, m.z, this.rng.range(1, 7));
    particles('heart', m.x, m.y + m.height, m.z, { count: 7, spread: 0.6 });
    this.partner = null;
  }
  stop() { this.partner = null; this.stopMoving(); }
}
defineGoal('breed', (mob, args) => new BreedGoal(mob, args));

const GRASS_NAMES = ['short_grass', 'grass', 'tall_grass', 'fern'];

/** Sheep crop the grass: animation, then grass_block turns to dirt. */
class EatGrassGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 6;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK | MUTEX_JUMP;
    this.ticks = 0;
    this.grassId = 0;
    this.dirtId = 0;
  }
  /** Ids resolved lazily so this file never touches the registry at load. */
  ids() {
    if (!this.dirtId) {
      this.dirtId = blockByName('dirt')?.id || 0;
      this.grassId = blockByName('grass_block')?.id || 0;
      this.plantIds = GRASS_NAMES.map((n) => blockByName(n)?.id || 0).filter((v) => v > 0);
    }
  }
  canStart() {
    const m = this.mob;
    if (m.baby ? this.rng.int(50) !== 0 : this.rng.int(1000) !== 0) return false;
    this.ids();
    const w = this.world;
    const x = Math.floor(m.x), y = Math.floor(m.y + 0.02), z = Math.floor(m.z);
    if (this.plantIds.indexOf(w.getBlock(x, y, z)) >= 0) return true;
    return w.getBlock(x, y - 1, z) === this.grassId;
  }
  start() {
    this.ids();
    this.ticks = 40;
    this.mob.eatTicks = 40;
    this.mob.eating = true;
    if (this.ai) this.ai.stopMoving();
  }
  canContinue() { return this.ticks > 0; }
  tick() {
    const m = this.mob;
    this.ticks--;
    m.eatTicks = this.ticks;
    // Head down at the ground for the whole animation.
    this.lookAt(m.x, m.y - 0.4, m.z, 0.35);
    this.ai.moveRequested = true;
    if (this.ticks !== 4) return;
    const w = this.world;
    const x = Math.floor(m.x), y = Math.floor(m.y + 0.02), z = Math.floor(m.z);
    const griefing = Game.world?.gameRules?.mobGriefing !== false;
    if (this.plantIds.indexOf(w.getBlock(x, y, z)) >= 0) {
      if (griefing) w.setBlock(x, y, z, 0, 0, 3);
      this.onAte();
    } else if (w.getBlock(x, y - 1, z) === this.grassId) {
      if (griefing) w.setBlock(x, y - 1, z, this.dirtId, 0, 3);
      this.onAte();
    }
    particles('block', m.x, m.y + 0.2, m.z, { count: 10, spread: 0.4, block: 'grass_block' });
    playAt(w, 'sheep_eat', m.x, m.y, m.z, 1, 1);
  }
  /** Wool grows back, and lambs grow up a little faster. */
  onAte() {
    const m = this.mob;
    if (m.sheared) { m.sheared = false; m.shorn = false; }
    if (m.baby && m.growTicks > 0) m.growTicks = Math.max(0, m.growTicks - 1200);
    try { this.def.onEatGrass?.(m); } catch { /* optional hook */ }
  }
  stop() { this.ticks = 0; this.mob.eatTicks = 0; this.mob.eating = false; }
}
defineGoal('eat_grass', (mob, args) => new EatGrassGoal(mob, args));

/** A sitting pet stays put; interacting with it toggles the flag. */
class SitGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 1;
    this.mutex = MUTEX_MOVE | MUTEX_JUMP;
  }
  canStart() {
    const m = this.mob;
    if (m._sitToggle) { m._sitToggle = false; m.sitting = !m.sitting; }
    if (!m.tamed && !m.sitting) return false;
    if (m.inWater || m.inLava) { m.sitting = false; return false; }
    return !!m.sitting;
  }
  canContinue() { return !!this.mob.sitting; }
  start() { if (this.ai) { this.ai.stopMoving(); this.ai.setTarget(null); } }
  tick() {
    const m = this.mob;
    m.vx *= 0.5; m.vz *= 0.5;
    m.jumping = false;
    this.ai.moveRequested = true;
  }
  // Losing the goal (water, a boss fight) does not un-sit the pet by itself;
  // only canStart's own checks and player interaction clear the flag.
  stop() { this.mob.jumping = false; }
}
defineGoal('sit', (mob, args) => new SitGoal(mob, args));

const BEG_ITEMS = ['bone', 'beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef',
  'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'rotten_flesh'];

/** Tamed wolves sit up and beg at a player holding meat. */
class BegGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 8;
    this.mutex = MUTEX_LOOK;
    this.range = args.range || 8;
    this.player = null;
    this.ticks = 0;
  }
  holding(p) {
    const s = typeof p.getHeldItem === 'function' ? p.getHeldItem() : null;
    const o = typeof p.getOffhandItem === 'function' ? p.getOffhandItem() : null;
    return !!((s && BEG_ITEMS.indexOf(s.item) >= 0) || (o && BEG_ITEMS.indexOf(o.item) >= 0));
  }
  canStart() {
    const m = this.mob;
    if (!m.tamed) return false;
    const p = this.nearestPlayer(this.range);
    if (!p || !this.holding(p)) return false;
    this.player = p;
    return true;
  }
  start() { this.ticks = this.rng.range(40, 96); this.mob.begging = true; }
  canContinue() {
    const p = this.player;
    if (!p || !isTargetable(p) || !this.holding(p)) return false;
    if (this.mob.distanceToSq(p.x, p.y, p.z) > this.range * this.range) return false;
    return this.ticks-- > 0;
  }
  tick() { this.lookAtEntity(this.player, 0.5); }
  stop() { this.mob.begging = false; this.player = null; }
}
defineGoal('beg', (mob, args) => new BegGoal(mob, args));

/** Foxes and piglins grab loose items off the ground. */
class StealItemGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 5;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.speed = args.speed || 1.2;
    this.range = args.range || 8;
    this.wanted = args.params || this.def.wantedItems || null;
    this.item = null;
  }
  interesting(e) {
    if (!e || e.removed || e.type !== 'item') return false;
    if (e.pickupDelay > 0) return false;
    const stack = e.stack || e.itemStack;
    if (!stack || !stack.item) return false;
    return !this.wanted || this.wanted.indexOf(stack.item) >= 0;
  }
  canStart() {
    const m = this.mob;
    if (m.equipment && m.equipment.mainhand) return false;
    const w = this.world;
    if (!w || !w.entitiesNear) return false;
    const near = w.entitiesNear(m.x, m.y, m.z, this.range, (e) => this.interesting(e));
    if (!near.length) return false;
    let best = near[0], bestD = m.distanceToSq(best.x, best.y, best.z);
    for (let i = 1; i < near.length; i++) {
      const d = m.distanceToSq(near[i].x, near[i].y, near[i].z);
      if (d < bestD) { bestD = d; best = near[i]; }
    }
    this.item = best;
    return true;
  }
  canContinue() { return this.interesting(this.item); }
  tick() {
    const m = this.mob;
    const e = this.item;
    if (!e) return;
    this.lookAt(e.x, e.y, e.z, 0.4);
    if (m.distanceToSq(e.x, e.y, e.z) > 1.4) { this.moveTo(e.x, e.y, e.z, this.speed); return; }
    const stack = e.stack || e.itemStack;
    if (typeof m.setEquipment === 'function') m.setEquipment('mainhand', { item: stack.item, count: 1, damage: stack.damage || 0 });
    if (stack.count > 1) stack.count--;
    else e.remove?.();
    playAt(this.world, 'item_pickup', m.x, m.y, m.z, 0.6, 1.4);
    this.item = null;
  }
  stop() { this.item = null; this.stopMoving(); }
}
defineGoal('steal_item', (mob, args) => new StealItemGoal(mob, args));

// ---- species specials -----------------------------------------------------

/** Endermen blink somewhere else when idle, wet or standing in the sun. */
class TeleportRandomGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 6;
    this.mutex = MUTEX_MOVE;
    this.range = args.range || 32;
  }
  canStart() {
    const m = this.mob;
    if (typeof m.teleportRandom !== 'function') return false;
    if (this.ai.target) return false;
    const bothered = m.inWater || m.fireTicks > 0 || (m.isInDaylight ? m.isInDaylight() : false);
    return this.rng.int(bothered ? 12 : 200) === 0;
  }
  canContinue() { return false; }    // one blink per activation
  start() { this.mob.teleportRandom(this.range); }
}
defineGoal('teleport_random', (mob, args) => new TeleportRandomGoal(mob, args));

/** Guardian laser: a long charge with a visible beam, then a burst of damage. */
class GuardianBeamGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 4;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.range = args.range || 15;
    this.chargeTime = args.chargeTime || (this.def.name === 'elder_guardian' ? 100 : 80);
    this.damage = args.damage || (this.def.name === 'elder_guardian' ? 8 : 6);
    this.charge = 0;
    this.cooldown = 0;
  }
  canStart() {
    const t = this.target;
    if (!t || !isTargetable(t) || peaceful()) return false;
    if (this.cooldown > 0) { this.cooldown--; return false; }
    return this.mob.distanceToSq(t.x, t.y, t.z) < this.range * this.range;
  }
  canContinue() {
    const m = this.mob;
    const t = this.target;
    if (!t || !isTargetable(t)) return false;
    if (m.distanceToSq(t.x, t.y, t.z) > this.range * this.range * 1.44) return false;
    return m.canSee ? m.canSee(t) : canSee(this.world, m, t);
  }
  start() {
    this.charge = 0;
    this.mob.beamTarget = this.target;
    this.mob.beamTicks = 0;
    playAt(this.world, 'guardian_attack', this.mob.x, this.mob.y, this.mob.z, 1, 1);
  }
  tick() {
    const m = this.mob;
    const t = this.target;
    this.charge++;
    m.beamTicks = this.charge;
    m.beamProgress = clamp(this.charge / this.chargeTime, 0, 1);
    this.lookAtEntity(t, 0.9);
    // Hold position, drifting slowly to keep the beam on line.
    const dist = Math.sqrt(m.distanceToSq(t.x, t.y, t.z));
    if (dist > this.range * 0.8) this.moveTo(t.x, t.y, t.z, 0.8);
    else this.ai.moveRequested = true;
    if (this.charge < this.chargeTime) return;
    if (t.hurt) t.hurt(this.damage, srcOf('magic', m, m));
    if (this.def.name === 'elder_guardian' && t.addEffect) t.addEffect('mining_fatigue', 6000, 2);
    particles('bubble', t.x, eyeY(t), t.z, { count: 12, spread: 0.5 });
    playAt(this.world, 'guardian_hit', m.x, m.y, m.z, 1, 1);
    this.charge = 0;
    this.cooldown = 40;
  }
  stop() {
    const m = this.mob;
    m.beamTarget = null;
    m.beamTicks = 0;
    m.beamProgress = 0;
    this.charge = 0;
    this.stopMoving();
  }
}
defineGoal('guardian_beam', (mob, args) => new GuardianBeamGoal(mob, args));

/** Shulkers crack their shell open now and then, and shoot while open. */
class ShulkerPeekGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 6;
    this.mutex = 0;
    this.ticks = 0;
    this.open = false;
  }
  canStart() { return this.rng.int(this.open ? 40 : 20) === 0; }
  start() {
    this.open = !this.open;
    this.ticks = this.open ? this.rng.range(40, 120) : this.rng.range(60, 200);
    playAt(this.world, this.open ? 'shulker_open' : 'shulker_close', this.mob.x, this.mob.y, this.mob.z, 1, 1);
  }
  canContinue() { return this.ticks-- > 0; }
  tick() {
    const m = this.mob;
    const want = this.open ? 1 : 0;
    m.peek = (m.peek || 0) + (want - (m.peek || 0)) * 0.2;
    if (!this.open) return;
    const t = this.ai.target;
    if (!t || !isTargetable(t)) return;
    this.lookAtEntity(t, 0.4);
    if (m.distanceToSq(t.x, t.y, t.z) > 256 || this.rng.int(40) !== 0) return;
    const dx = t.x - m.x, dy = eyeY(t) - eyeY(m), dz = t.z - m.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    shoot('shulker_bullet', this.world, m, m.x, m.y + 0.6, m.z, dx / len, dy / len, dz / len, { target: t });
    playAt(this.world, 'shulker_shoot', m.x, m.y, m.z, 1, 1);
  }
}
defineGoal('shulker_peek', (mob, args) => new ShulkerPeekGoal(mob, args));

/** Phantoms orbit high above their prey, then dive through it. */
class PhantomCircleGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 2;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.state = 'circle';
    this.angle = 0;
    this.radius = 14;
    this.height = 12;
    this.timer = 0;
  }
  canStart() {
    const t = this.ai.target || this.nearestPlayer(64);
    if (!t) return false;
    if (!this.ai.target) this.setTarget(t);
    return true;
  }
  canContinue() { return !!(this.ai.target && isTargetable(this.ai.target)); }
  start() {
    this.state = 'circle';
    this.angle = this.rng.next() * Math.PI * 2;
    this.radius = this.rng.float(10, 18);
    this.height = this.rng.float(8, 16);
    this.timer = this.rng.range(60, 140);
  }
  tick() {
    const m = this.mob;
    const t = this.ai.target;
    this.ai.moveRequested = true;
    if (this.state === 'circle') this.circle(m, t);
    else this.swoop(m, t);
  }
  /** Lazy orbit above the target while the timer runs down. */
  circle(m, t) {
    this.angle += 0.045;
    const tx = t.x + Math.cos(this.angle) * this.radius;
    const tz = t.z + Math.sin(this.angle) * this.radius;
    const ty = t.y + this.height;
    this.ai.steer(tx, ty, tz, 1.1);
    this.lookAt(t.x, eyeY(t), t.z, 0.15);
    if (--this.timer > 0) return;
    this.state = 'swoop';
    this.timer = 60;
    playAt(this.world, 'phantom_swoop', m.x, m.y, m.z, 1, 1);
  }
  /** The dive: straight at the target, biting anything it passes through. */
  swoop(m, t) {
    this.ai.steer(t.x, eyeY(t) - 0.3, t.z, 2.2);
    this.lookAtEntity(t, 0.5);
    const distSq = m.distanceToSq(t.x, t.y, t.z);
    if (distSq < 2.2 && (m.attackCooldown || 0) <= 0) {
      if (typeof m.attack === 'function') m.attack(t);
      else if (t.hurt) t.hurt(this.def.damage || 2, srcOf('mob', m, m));
    }
    // Pull out of the dive once it is past the target or it has been too long.
    if (--this.timer > 0 && m.y > t.y - 0.5 && !m.horizontalCollision) return;
    this.state = 'circle';
    this.timer = this.rng.range(40, 100);
    this.radius = this.rng.float(10, 18);
    this.height = this.rng.float(8, 16);
    m.vy = Math.max(m.vy, 4);
  }
  stop() { this.state = 'circle'; }
}
defineGoal('phantom_circle', (mob, args) => new PhantomCircleGoal(mob, args));

/** Ravagers put their head down and run, and knock themselves silly on walls. */
class RavagerChargeGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 3;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.cooldown = 0;
    this.ticks = 0;
    this.dx = 0; this.dz = 0;
  }
  canStart() {
    const m = this.mob;
    const t = this.target;
    if (!t || !isTargetable(t) || (m.stunTicks || 0) > 0) return false;
    if (this.cooldown > 0) { this.cooldown--; return false; }
    const d = m.distanceToSq(t.x, t.y, t.z);
    if (d < 16 || d > 400) return false;
    if (!(m.canSee ? m.canSee(t) : canSee(this.world, m, t))) return false;
    return this.rng.int(10) === 0;
  }
  start() {
    const m = this.mob;
    const t = this.target;
    this.ticks = 40;
    const dx = t.x - m.x, dz = t.z - m.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    this.dx = dx / len; this.dz = dz / len;
    m.charging = true;
    playAt(this.world, 'ravager_roar', m.x, m.y, m.z, 2, 1);
  }
  canContinue() { return this.ticks > 0 && (this.mob.stunTicks || 0) <= 0; }
  tick() {
    const m = this.mob;
    const t = this.target;
    this.ticks--;
    this.ai.moveRequested = true;
    const want = this.ai.speedFor(1.9);
    if (m.onGround) { m.vx = this.dx * want; m.vz = this.dz * want; }
    const yaw = Math.atan2(-this.dx, this.dz);
    m.yaw += angleDiff(m.yaw, yaw) * 0.3;
    m.headYaw = m.yaw;
    // Slam into the target: heavy damage plus a launch.
    if (t && m.distanceToSq(t.x, t.y, t.z) < meleeReachSq(m, t) * 1.6) {
      const kbSrc = srcOf('mob', m, m); kbSrc.knockback = 2.2;
      if (t.hurt && t.hurt((this.def.damage || 12) * 1.5, kbSrc)) {
        t.vy = Math.max(t.vy || 0, 6);
      }
      this.ticks = 0;
      this.cooldown = 60;
      return;
    }
    if (!m.horizontalCollision) return;
    // Ran into a wall: stunned, and any leaves in the way are pulped.
    m.stunTicks = 40;
    m.charging = false;
    this.ticks = 0;
    this.cooldown = 100;
    playAt(this.world, 'ravager_stunned', m.x, m.y, m.z, 2, 1);
    if (Game.world?.gameRules?.mobGriefing === false) return;
    const w = this.world;
    const bx = Math.floor(m.x + this.dx), bz = Math.floor(m.z + this.dz);
    for (let y = Math.floor(m.y); y <= Math.floor(m.y + 2); y++) {
      const d = getBlock(w.getBlock(bx, y, bz));
      if (d.name && d.name.indexOf('leaves') >= 0) w.setBlock(bx, y, bz, 0, 0, 3);
    }
  }
  stop() { this.mob.charging = false; this.stopMoving(); }
}
defineGoal('ravager_charge', (mob, args) => new RavagerChargeGoal(mob, args));

/** The warden stops, sniffs, and finds you even through a wall. */
class WardenSniffGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 5;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK;
    this.range = args.range || 24;
    this.ticks = 0;
    this.cooldown = 0;
  }
  canStart() {
    if (this.cooldown > 0) { this.cooldown--; return false; }
    if (this.ai.target && this.mob.distanceToSq(this.ai.target.x, this.ai.target.y, this.ai.target.z) < 36) return false;
    return this.rng.int(60) === 0;
  }
  start() {
    this.ticks = 100;
    this.mob.sniffing = true;
    playAt(this.world, 'warden_sniff', this.mob.x, this.mob.y, this.mob.z, 2, 1);
  }
  canContinue() { return this.ticks-- > 0; }
  tick() {
    const m = this.mob;
    this.ai.moveRequested = true;
    m.vx *= 0.7; m.vz *= 0.7;
    if (this.ticks !== 20) return;
    // The sniff resolves: whoever is nearest gets found, walls or not.
    const w = this.world;
    let best = null, bestD = this.range * this.range;
    const players = w.getPlayers ? w.getPlayers() : [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!isTargetable(p)) continue;
      const d = m.distanceToSq(p.x, p.y, p.z);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return;
    this.setTarget(best);
    m.angerTicks = 600;
    this.lookAtEntity(best, 0.8);
    playAt(w, 'warden_angry', m.x, m.y, m.z, 2, 1);
  }
  stop() { this.mob.sniffing = false; this.cooldown = 120; }
}
defineGoal('warden_sniff', (mob, args) => new WardenSniffGoal(mob, args));

// ---- bosses ---------------------------------------------------------------

/**
 * The ender dragon fight: it circles the fountain, strafes with fireballs,
 * charges the player and periodically perches on the portal.
 */
class BossDragonGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 0;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK | MUTEX_JUMP;
    this.phase = 'circle';
    this.angle = 0;
    this.timer = 0;
    this.cx = 0; this.cy = 78; this.cz = 0;
  }
  canStart() { return true; }
  canContinue() { return true; }
  start() {
    const m = this.mob;
    this.cx = m.homeX !== undefined ? m.homeX : 0;
    this.cz = m.homeZ !== undefined ? m.homeZ : 0;
    this.cy = m.homeY !== undefined ? m.homeY : Math.max(70, m.y);
    this.angle = this.rng.next() * Math.PI * 2;
    this.setPhase('circle', this.rng.range(120, 260));
    m.noGravity = true;
    m.gravity = 0;
  }
  /** Switches phase and announces it on the mob for the renderer. */
  setPhase(p, ticks) {
    this.phase = p;
    this.timer = ticks;
    this.mob.dragonPhase = p;
  }
  tick() {
    const m = this.mob;
    this.ai.moveRequested = true;
    m.fallDistance = 0;
    const t = this.ai.target || this.nearestPlayer(80);
    if (t && !this.ai.target) this.setTarget(t);
    this.timer--;
    switch (this.phase) {
      case 'circle': this.circle(m, t); break;
      case 'strafe': this.strafe(m, t); break;
      case 'charge': this.charge(m, t); break;
      default: this.perch(m, t); break;
    }
    this.damageContact(m);
  }
  /** Wide lazy orbit around the end fountain. */
  circle(m, t) {
    this.angle += 0.03;
    const r = 34;
    this.ai.steer(this.cx + Math.cos(this.angle) * r, this.cy + 6 + Math.sin(this.angle * 0.7) * 4,
      this.cz + Math.sin(this.angle) * r, 1.4);
    if (this.timer > 0) return;
    if (!t) { this.setPhase('circle', 160); return; }
    const roll = this.rng.next();
    if (roll < 0.4) this.setPhase('strafe', 160);
    else if (roll < 0.75) this.setPhase('charge', 120);
    else this.setPhase('perch', 300);
  }
  /** Flies wide of the player and spits dragon fireballs. */
  strafe(m, t) {
    if (!t) { this.setPhase('circle', 160); return; }
    this.angle += 0.05;
    this.ai.steer(t.x + Math.cos(this.angle) * 22, t.y + 14, t.z + Math.sin(this.angle) * 22, 1.5);
    this.lookAtEntity(t, 0.2);
    if ((this.timer % 40) === 0) {
      const dx = t.x - m.x, dy = (t.y + 1) - (m.y + m.height * 0.5), dz = t.z - m.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      shoot('dragon_fireball', this.world, m, m.x, m.y + m.height * 0.5, m.z, dx / len, dy / len, dz / len, {});
      playAt(this.world, 'dragon_shoot', m.x, m.y, m.z, 4, 1);
    }
    if (this.timer <= 0) this.setPhase('circle', this.rng.range(80, 160));
  }
  /** Straight-line pass through the player. */
  charge(m, t) {
    if (!t) { this.setPhase('circle', 160); return; }
    this.ai.steer(t.x, t.y + 1.5, t.z, 2.4);
    this.lookAtEntity(t, 0.3);
    if (this.timer <= 0 || m.distanceToSq(t.x, t.y, t.z) < 4) this.setPhase('circle', this.rng.range(100, 200));
  }
  /** Sits on the portal, breathing and vulnerable to melee. */
  perch(m, t) {
    this.ai.steer(this.cx, this.cy - 12, this.cz, 1.2);
    m.perching = true;
    if (t && (this.timer % 60) === 0 && m.distanceToSq(t.x, t.y, t.z) < 900) {
      particles('dragon_breath', this.cx, this.cy - 12, this.cz, { count: 24, spread: 3 });
      if (t.hurt) t.hurt(3, srcOf('magic', m, m));
    }
    if (this.timer > 0) return;
    m.perching = false;
    this.setPhase('circle', this.rng.range(160, 300));
  }
  /** Anything the dragon flies through gets swatted. */
  damageContact(m) {
    const w = this.world;
    if (!w || !w.entitiesNear || (this.ai.tickCount % 5) !== 0) return;
    const near = w.entitiesNear(m.x, m.y + m.height * 0.5, m.z, 5,
      (e) => e !== m && (e.isPlayer || e.type === 'player'));
    for (let i = 0; i < near.length; i++) {
      const e = near[i];
      const kbSrc = srcOf('mob', m, m); kbSrc.knockback = 1.8;
      if (e.hurt) e.hurt(6, kbSrc);
    }
  }
  stop() { this.mob.perching = false; }
}
defineGoal('boss_dragon', (mob, args) => new BossDragonGoal(mob, args));

/**
 * The wither fight: a spawn charge that ends in an explosion, then a hovering
 * skull barrage, then a faster armoured second phase below half health.
 */
class BossWitherGoal extends Goal {
  constructor(mob, args) {
    super(mob, args);
    this.priority = 0;
    this.mutex = MUTEX_MOVE | MUTEX_LOOK | MUTEX_JUMP;
    this.spawnTicks = 220;
    this.skullCooldown = 0;
    this.chargeCooldown = 0;
  }
  canStart() { return true; }
  canContinue() { return true; }
  start() {
    const m = this.mob;
    if (m.witherSpawnTicks === undefined) m.witherSpawnTicks = this.spawnTicks;
    m.noGravity = true;
    m.gravity = 0;
    m.invulnerable = m.witherSpawnTicks > 0;
  }
  tick() {
    const m = this.mob;
    this.ai.moveRequested = true;
    m.fallDistance = 0;
    if (m.witherSpawnTicks > 0) { this.spawnCharge(m); return; }

    const half = m.health <= m.maxHealth * 0.5;
    m.witherArmored = half;
    m.invulnerable = false;
    const t = this.ai.target || this.nearestPlayer(48);
    if (t && !this.ai.target) this.setTarget(t);
    if (!t) { this.hover(m, m.x, m.y, m.z); return; }

    this.lookAtEntity(t, 0.25);
    const dist = Math.sqrt(m.distanceToSq(t.x, t.y, t.z));
    if (half && this.chargeCooldown <= 0 && dist < 20) {
      // Armoured phase: dive at the player and swat them aside.
      this.ai.steer(t.x, t.y + 1, t.z, 2.2);
      if (dist < 3) {
        const kbSrc = srcOf('mob', m, m); kbSrc.knockback = 2;
        if (t.hurt) t.hurt(8, kbSrc);
        this.chargeCooldown = 100;
      }
    } else {
      this.hover(m, t.x, t.y + 5, t.z);
    }
    if (this.chargeCooldown > 0) this.chargeCooldown--;
    if (this.skullCooldown > 0) { this.skullCooldown--; return; }
    this.fireSkulls(m, t, half);
  }
  /** The 220-tick charge-up, ending in the arena-flattening blast. */
  spawnCharge(m) {
    m.witherSpawnTicks--;
    m.invulnerable = true;
    m.health = Math.min(m.maxHealth, m.health + m.maxHealth / 440);
    this.hover(m, m.x, m.y, m.z);
    if ((m.witherSpawnTicks % 10) === 0) {
      particles('smoke', m.x, m.y + m.height * 0.6, m.z, { count: 6, spread: 1.2 });
    }
    if (m.witherSpawnTicks > 0) return;
    m.invulnerable = false;
    const c = MOD.combat;
    if (c && typeof c.explode === 'function') {
      try {
        c.explode(this.world, m.x, m.y + m.height * 0.5, m.z, 7,
          { fire: false, breakBlocks: Game.world?.gameRules?.mobGriefing !== false, source: m });
      } catch { /* explosion is cosmetic if combat is missing */ }
    }
    playAt(this.world, 'wither_spawn', m.x, m.y, m.z, 4, 1);
  }
  /** Holds station near a point without ever touching the ground. */
  hover(m, x, y, z) {
    const w = this.world;
    let ty = y;
    // Never sink into the floor: keep a few blocks of air underneath.
    const bx = Math.floor(m.x), bz = Math.floor(m.z);
    for (let i = 0; i < 4; i++) if (w.isSolid(bx, Math.floor(m.y) - i, bz)) { ty = Math.max(ty, m.y + 1.5); break; }
    this.ai.steer(x, ty, z, 1.2);
  }
  /** Up to three skulls: one aimed, two scattered at other nearby victims. */
  fireSkulls(m, t, half) {
    const w = this.world;
    this.skullCooldown = half ? 20 : 40;
    this.launch(m, t, false);
    if (!half) return;
    const near = w.entitiesNear ? w.entitiesNear(m.x, m.y, m.z, 24,
      (e) => e !== m && e !== t && isTargetable(e) && (e.isPlayer || (e.isMob && !defOf(e).boss))) : [];
    for (let i = 0; i < Math.min(2, near.length); i++) this.launch(m, near[i], this.rng.chance(0.25));
  }
  /** One wither skull toward an entity. */
  launch(m, t, blue) {
    if (!t) return;
    const ox = m.x, oy = m.y + m.height * 0.75, oz = m.z;
    const dx = t.x - ox, dy = eyeY(t) - oy, dz = t.z - oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    shoot('wither_skull', this.world, m, ox, oy, oz, dx / len, dy / len, dz / len, { blue });
    playAt(this.world, 'wither_shoot', m.x, m.y, m.z, 2, 1);
  }
  stop() { /* the wither never stops */ }
}
defineGoal('boss_wither', (mob, args) => new BossWitherGoal(mob, args));

/** Every goal name this module knows, handy for validation tools. */
export const GOAL_NAMES = Object.freeze(Object.keys(GOALS));
