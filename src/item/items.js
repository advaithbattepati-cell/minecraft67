// ============================================================================
// items.js - The item registry.
//
// Everything the player can hold lives here: block items (auto-generated from
// the block registry), tools, armour, food, ingredients, potions, spawn eggs
// and the creative-menu tabs.
//
// Nothing in this file touches the DOM or three.js at module scope, so it can
// be imported by tools/validate.mjs in plain Node. The right-click handlers do
// reach into other subsystems, but always through a lazy `import()` performed
// inside the handler, so importing this module never drags the renderer in.
// ============================================================================
import { prettyName } from '../core/util.js';
import { FACE_DIRS } from '../core/constants.js';
import { Game } from '../core/game.js';
import { BLOCKS, BLOCK_BY_NAME } from '../world/blocks.js';

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/** name -> item definition. */
export const ITEMS = {};
/** Registration-ordered list of every item name. */
export const ITEM_NAMES = [];
/** [{ id, name, icon, items: [names] }] - the creative menu. Filled at the end. */
export const CREATIVE_TABS = [];

const NOOP_FALSE = () => false;

/**
 * Registers an item. Returns the definition. Registering a name twice keeps
 * the first definition (so explicit items always win over auto-generated
 * block items).
 */
export function defineItem(name, def = {}) {
  const existing = ITEMS[name];
  if (existing) return existing;
  const tool = def.tool || null;
  const armor = def.armor || null;
  const durability = def.durability !== undefined
    ? def.durability
    : (tool ? tool.durability || 0 : armor ? armor.durability || 0 : 0);
  const item = {
    name,
    display: def.display || prettyName(name),
    stack: def.stack !== undefined ? def.stack : (durability ? 1 : 64),
    texture: def.texture || name,
    block: def.block !== undefined ? def.block : null,
    group: def.group || 'misc',
    tab: def.tab || null,
    rarity: def.rarity || 'common',
    tool,
    armor,
    food: def.food || null,
    fuel: def.fuel || 0,
    enchantability: def.enchantability || 0,
    repairWith: def.repairWith || null,
    durability,
    usesLeft: def.usesLeft !== undefined ? def.usesLeft : null,
    // extra metadata other modules read opportunistically
    color: def.color !== undefined ? def.color : null,
    color2: def.color2 !== undefined ? def.color2 : null,
    potion: def.potion || null,
    mob: def.mob || null,
    music: def.music || null,
    useAction: def.useAction || null,     // 'eat'|'drink'|'bow'|'crossbow'|'block'|'spyglass'|'toot'
    useDuration: def.useDuration || 0,    // ticks the use animation runs for
    projectile: def.projectile || null,
    equipSlot: def.equipSlot || (armor ? armor.slot : null),
    tags: def.tags || null,
    stub: !!def.stub,
    // hooks - always callable, default to a no-op returning false
    onUse: def.onUse || NOOP_FALSE,
    onUseOnBlock: def.onUseOnBlock || NOOP_FALSE,
    onUseOnEntity: def.onUseOnEntity || NOOP_FALSE,
    onFinishUsing: def.onFinishUsing || NOOP_FALSE,
    onStopUsing: def.onStopUsing || NOOP_FALSE,
    onHitEntity: def.onHitEntity || NOOP_FALSE,
    onBreakBlock: def.onBreakBlock || NOOP_FALSE,
  };
  ITEMS[name] = item;
  ITEM_NAMES.push(name);
  return item;
}

/**
 * Looks an item up by name. Never returns undefined: an unknown name gets a
 * generated stub so a typo somewhere else degrades into a weird-looking item
 * instead of a crash.
 */
export function getItem(name) {
  const d = ITEMS[name];
  if (d) return d;
  const key = typeof name === 'string' && name ? name : 'unknown_item';
  const stub = {
    name: key, display: prettyName(key), stack: 64, texture: key, block: BLOCK_BY_NAME.has(key) ? key : null,
    group: 'misc', tab: 'misc', rarity: 'common', tool: null, armor: null, food: null, fuel: 0,
    enchantability: 0, repairWith: null, durability: 0, usesLeft: null, color: null, color2: null,
    potion: null, mob: null, music: null, useAction: null, useDuration: 0, projectile: null,
    equipSlot: null, tags: null, stub: true,
    onUse: NOOP_FALSE, onUseOnBlock: NOOP_FALSE, onUseOnEntity: NOOP_FALSE, onFinishUsing: NOOP_FALSE,
    onStopUsing: NOOP_FALSE, onHitEntity: NOOP_FALSE, onBreakBlock: NOOP_FALSE,
  };
  ITEMS[key] = stub;   // cache so repeated lookups are stable and cheap
  return stub;
}

/** True when `name` was explicitly or automatically registered. */
export function itemExists(name) {
  const d = ITEMS[name];
  return !!d && !d.stub;
}

// ---------------------------------------------------------------------------
// Runtime helpers used by the right-click handlers
// ---------------------------------------------------------------------------

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const DYE_HEX = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52,
  0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
const NETHER_WOODS = ['crimson', 'warped'];

/** Numeric block id for a block name (0 = air when unknown). */
function bid(name) {
  const d = BLOCK_BY_NAME.get(name);
  return d ? d.id : 0;
}
/** Block name at a world position. */
function bname(world, x, y, z) {
  const d = BLOCKS[world.getBlock(x, y, z)];
  return d ? d.name : 'air';
}

function isCreative(player) {
  if (player && player.gameMode) return player.gameMode === 'creative';
  return Game.mode === 'creative';
}

/** Makes a bare item stack. Deliberately duplicates inventory.stack() to keep this module standalone. */
function mkStack(item, count = 1) {
  return { item, count, damage: 0 };
}

/** Finds and clears the inventory slot that literally holds `stack`. */
function clearStack(player, stack) {
  const inv = player && player.inventory;
  if (!inv) return;
  for (let i = 0; i < inv.size; i++) {
    if (inv.get(i) === stack) { inv.set(i, null); return; }
  }
}

/** Consumes `n` from a stack, respecting creative mode. */
function shrink(player, stack, n = 1) {
  if (!stack || isCreative(player)) return;
  stack.count -= n;
  if (stack.count <= 0) clearStack(player, stack);
}

/** Gives a stack to the player, dropping the remainder in the world. */
function giveOrDrop(player, s) {
  if (!s || !player) return;
  const left = player.giveItem ? player.giveItem(s) : s;
  if (left && player.world) {
    withMod(MOD.itementity, (m) => m.dropItem(player.world, player.x, player.y + 1, player.z, left, 0, 0.2, 0));
  }
}

/** Turns the held stack into a different item (bucket -> water bucket, bottle -> potion). */
function replaceStack(player, stack, newName) {
  if (isCreative(player)) {
    if (!player.inventory || !player.inventory.has || !player.inventory.has(newName, 1)) giveOrDrop(player, mkStack(newName, 1));
    return;
  }
  if (!stack) { giveOrDrop(player, mkStack(newName, 1)); return; }
  if (stack.count > 1) { stack.count -= 1; giveOrDrop(player, mkStack(newName, 1)); return; }
  const inv = player.inventory;
  if (inv) {
    for (let i = 0; i < inv.size; i++) {
      if (inv.get(i) === stack) { inv.set(i, mkStack(newName, 1)); return; }
    }
  }
  stack.item = newName;
  stack.damage = 0;
}

/** Applies durability damage; removes the stack when it breaks. */
function damageItem(player, stack, amount = 1) {
  if (!stack || isCreative(player)) return;
  const def = getItem(stack.item);
  if (!def.durability) return;
  stack.damage = (stack.damage || 0) + amount;
  if (stack.damage >= def.durability) {
    clearStack(player, stack);
    playSound(player, 'item_break', 1, 1);
  }
}

function playSound(player, name, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || !player) return;
  if (a.playAt) a.playAt(name, player.x, player.y, player.z, volume, pitch);
  else if (a.play) a.play(name, { volume, pitch, x: player.x, y: player.y, z: player.z });
}
function playSoundAt(x, y, z, name, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a) return;
  if (a.playAt) a.playAt(name, x, y, z, volume, pitch);
  else if (a.play) a.play(name, { volume, pitch, x, y, z });
}
function particles(type, x, y, z, opts) {
  if (Game.particles && Game.particles.spawn) Game.particles.spawn(type, x, y, z, opts);
}

// Lazy module loaders. Handlers call `withMod(MOD.mobs, m => ...)` so importing
// items.js in Node never pulls in the renderer or the DOM.
const MOD = {
  mobs: () => import('../entity/mobs.js'),
  projectiles: () => import('../entity/projectiles.js'),
  vehicles: () => import('../entity/vehicles.js'),
  itementity: () => import('../entity/itementity.js'),
  combat: () => import('../entity/combat.js'),
  features: () => import('../world/features.js'),
  blockupdate: () => import('../world/blockupdate.js'),
  effects: () => import('./effects.js'),
  loot: () => import('./loot.js'),
};

let _warned = new Set();
/** Runs `fn` once a lazily-imported module resolves. Failures are reported once. */
function withMod(loader, fn) {
  let p;
  try { p = loader(); } catch (e) { p = Promise.reject(e); }
  p.then(
    (m) => { try { fn(m); } catch (e) { console.warn('[items] handler failed', e); } },
    (e) => { const k = String(e && e.message); if (!_warned.has(k)) { _warned.add(k); console.warn('[items] module unavailable', e); } },
  );
}

/** Unit look vector for a player/entity. */
function lookVec(e) {
  const cp = Math.cos(e.pitch || 0), sp = Math.sin(e.pitch || 0);
  const cy = Math.cos(e.yaw || 0), sy = Math.sin(e.yaw || 0);
  return { x: -sy * cp, y: -sp, z: cy * cp };
}

/** The position one step out from a raycast hit, along the hit face. */
function offsetHit(hit) {
  const d = FACE_DIRS[hit.face] !== undefined ? FACE_DIRS[hit.face] : [0, 1, 0];
  return { x: hit.x + d[0], y: hit.y + d[1], z: hit.z + d[2] };
}

/** True when a block can be replaced by whatever we are about to put there. */
function replaceableAt(world, x, y, z) {
  const d = BLOCKS[world.getBlock(x, y, z)];
  return !d || d.air || d.replaceable;
}

/** Eye position of an entity. */
function eyeOf(e) {
  return { x: e.x, y: e.y + (e.eyeHeight !== undefined ? e.eyeHeight : 1.62), z: e.z };
}

/** Drops a loose item stack in the world. */
function dropAt(world, x, y, z, name, count = 1) {
  withMod(MOD.itementity, (m) => m.dropItem(world, x, y, z, mkStack(name, count), 0, 0.1, 0));
}

// ---------------------------------------------------------------------------
// Generic hook builders
// ---------------------------------------------------------------------------

/** Right-click throws a projectile of `type`. */
function throwHandler(type, speed = 1.5, sound = 'throw', consume = true) {
  return (world, player, stack) => {
    const eye = eyeOf(player);
    const d = lookVec(player);
    withMod(MOD.projectiles, (m) => {
      m.spawnProjectile(type, world, player, eye.x, eye.y, eye.z, d.x * speed, d.y * speed, d.z * speed, { item: stack ? stack.item : null });
    });
    playSound(player, sound, 0.5, 0.4 + Math.random() * 0.4);
    if (consume) shrink(player, stack, 1);
    return true;
  };
}

/** Starts the eating animation for a food item. */
function startEating(world, player, stack) {
  const def = getItem(stack.item);
  const food = def.food;
  if (!food) return false;
  const full = player.hunger !== undefined && player.hunger >= 20;
  if (full && !food.alwaysEdible && !isCreative(player)) return false;
  player.usingItem = stack;
  player.useTicks = 0;
  player.useDuration = food.eatTicks || 32;
  return true;
}

/** Applies a food item's nutrition and effects, then returns any container item. */
function finishEating(world, player, stack) {
  const def = getItem(stack.item);
  const food = def.food;
  if (!food) return false;
  const before = stack.count;
  if (player.eat) {
    // Player.eat() owns hunger/saturation bookkeeping when the player module
    // provides it; it may or may not consume the stack itself.
    player.eat(stack);
  } else {
    player.hunger = Math.min(20, (player.hunger || 0) + food.hunger);
    player.saturation = Math.min(player.hunger, (player.saturation || 0) + food.saturation);
  }
  if (food.effects && food.effects.length) {
    for (const [name, ticks, level, chance] of food.effects) {
      if (chance !== undefined && Math.random() > chance) continue;
      if (player.addEffect) player.addEffect(name, ticks, level || 0);
    }
  }
  if (food.heal && player.heal) player.heal(food.heal);
  playSound(player, 'burp', 0.5, 0.9 + Math.random() * 0.2);
  if (stack.count === before) shrink(player, stack, 1);
  if (food.container) giveOrDrop(player, mkStack(food.container, 1));
  return true;
}

const FOOD_USE = (world, player, stack) => startEating(world, player, stack);
const FOOD_FINISH = (world, player, stack) => finishEating(world, player, stack);

/** Right-click swaps a wearable into its armour slot. */
function equipHandler(slotIndex) {
  return (world, player, stack) => {
    const inv = player.inventory;
    if (!inv || !inv.getArmor) return false;
    const cur = inv.getArmor(slotIndex);
    if (cur && cur.item === stack.item) return false;
    const copy = { item: stack.item, count: 1, damage: stack.damage || 0 };
    if (stack.enchants) copy.enchants = stack.enchants;
    inv.setArmor(slotIndex, copy);
    shrink(player, stack, 1);
    if (cur) giveOrDrop(player, cur);
    playSound(player, 'equip_armor', 1, 1);
    return true;
  };
}

/** Drinking: potions, milk, honey. */
function drinkUse(world, player, stack) {
  player.usingItem = stack;
  player.useTicks = 0;
  player.useDuration = 32;
  return true;
}

// ---------------------------------------------------------------------------
// Tool behaviour: tilling, path making, log stripping
// ---------------------------------------------------------------------------

const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt', 'mycelium', 'podzol']);

function hoeUse(world, player, stack, hit) {
  if (!hit) return false;
  const name = bname(world, hit.x, hit.y, hit.z);
  if (!TILLABLE.has(name)) return false;
  if (!replaceableAt(world, hit.x, hit.y + 1, hit.z)) return false;
  const out = name === 'coarse_dirt' ? 'dirt' : name === 'rooted_dirt' ? 'dirt' : 'farmland';
  world.setBlock(hit.x, hit.y, hit.z, bid(out), 0);
  if (name === 'rooted_dirt') dropAt(world, hit.x, hit.y + 1, hit.z, 'hanging_roots', 1);
  playSoundAt(hit.x, hit.y, hit.z, 'hoe_till', 1, 1);
  damageItem(player, stack, 1);
  return true;
}

function shovelUse(world, player, stack, hit) {
  if (!hit) return false;
  const name = bname(world, hit.x, hit.y, hit.z);
  if (name !== 'grass_block' && name !== 'dirt' && name !== 'coarse_dirt' && name !== 'podzol' && name !== 'mycelium' && name !== 'rooted_dirt') return false;
  if (!replaceableAt(world, hit.x, hit.y + 1, hit.z)) return false;
  world.setBlock(hit.x, hit.y, hit.z, bid('dirt_path'), 0);
  playSoundAt(hit.x, hit.y, hit.z, 'shovel_flatten', 1, 1);
  damageItem(player, stack, 1);
  return true;
}

// log/wood -> stripped, plus copper scraping and wax removal
const STRIP_MAP = new Map();
for (const w of WOODS) {
  STRIP_MAP.set(`${w}_log`, `stripped_${w}_log`);
  STRIP_MAP.set(`${w}_wood`, `stripped_${w}_wood`);
}
for (const w of NETHER_WOODS) {
  STRIP_MAP.set(`${w}_stem`, `stripped_${w}_stem`);
  STRIP_MAP.set(`${w}_hyphae`, `stripped_${w}_hyphae`);
}
STRIP_MAP.set('bamboo_block', 'stripped_bamboo_block');
const SCRAPE_MAP = new Map([
  ['oxidized_copper', 'weathered_copper'], ['weathered_copper', 'exposed_copper'], ['exposed_copper', 'copper_block'],
  ['oxidized_cut_copper', 'weathered_cut_copper'], ['weathered_cut_copper', 'exposed_cut_copper'], ['exposed_cut_copper', 'cut_copper'],
  ['oxidized_cut_copper_stairs', 'weathered_cut_copper_stairs'], ['weathered_cut_copper_stairs', 'exposed_cut_copper_stairs'], ['exposed_cut_copper_stairs', 'cut_copper_stairs'],
  ['oxidized_cut_copper_slab', 'weathered_cut_copper_slab'], ['weathered_cut_copper_slab', 'exposed_cut_copper_slab'], ['exposed_cut_copper_slab', 'cut_copper_slab'],
]);
const DEWAX_MAP = new Map();
for (const n of BLOCK_BY_NAME.keys()) {
  if (n.startsWith('waxed_')) DEWAX_MAP.set(n, n.slice(6));
}

function axeUse(world, player, stack, hit) {
  if (!hit) return false;
  const name = bname(world, hit.x, hit.y, hit.z);
  const meta = world.getMeta(hit.x, hit.y, hit.z);
  const strip = STRIP_MAP.get(name);
  if (strip) {
    world.setBlock(hit.x, hit.y, hit.z, bid(strip), meta);
    playSoundAt(hit.x, hit.y, hit.z, 'axe_strip', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  const dewax = DEWAX_MAP.get(name);
  if (dewax) {
    world.setBlock(hit.x, hit.y, hit.z, bid(dewax), meta);
    playSoundAt(hit.x, hit.y, hit.z, 'axe_wax_off', 1, 1);
    particles('crit', hit.x + 0.5, hit.y + 1, hit.z + 0.5, { count: 6, color: 0xd88f6a });
    damageItem(player, stack, 1);
    return true;
  }
  const scrape = SCRAPE_MAP.get(name);
  if (scrape) {
    world.setBlock(hit.x, hit.y, hit.z, bid(scrape), meta);
    playSoundAt(hit.x, hit.y, hit.z, 'axe_scrape', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Flint and steel: fire, TNT, portals
// ---------------------------------------------------------------------------

function isPortalInterior(world, x, y, z) {
  const d = BLOCKS[world.getBlock(x, y, z)];
  return !d || d.air || d.name === 'fire' || d.name === 'nether_portal';
}

/**
 * Tries to light a 2..21 wide obsidian frame around (x,y,z). Returns true when a
 * portal was created. Checks both the X and Z aligned orientations.
 */
function tryLightPortal(world, x, y, z) {
  const OBS = bid('obsidian');
  const PORTAL = bid('nether_portal');
  for (let axis = 0; axis < 2; axis++) {
    const dx = axis === 0 ? 1 : 0;
    const dz = axis === 0 ? 0 : 1;
    // Walk down to the lowest interior cell.
    let by = y;
    while (by > 1 && isPortalInterior(world, x, by - 1, z)) by--;
    if (world.getBlock(x, by - 1, z) !== OBS) continue;
    // Horizontal extent of the interior at the bottom row.
    let left = 0;
    while (left < 21 && isPortalInterior(world, x - dx * (left + 1), by, z - dz * (left + 1))) left++;
    let right = 0;
    while (right < 21 && isPortalInterior(world, x + dx * (right + 1), by, z + dz * (right + 1))) right++;
    const w = left + right + 1;
    if (w < 2 || w > 21) continue;
    const ox = x - dx * left, oz = z - dz * left;
    // Bottom frame and the two side columns must be obsidian.
    let ok = true;
    for (let i = 0; i < w && ok; i++) {
      if (world.getBlock(ox + dx * i, by - 1, oz + dz * i) !== OBS) ok = false;
    }
    if (!ok) continue;
    // Interior height.
    let h = 0;
    while (h < 21) {
      let clear = true;
      for (let i = 0; i < w; i++) {
        if (!isPortalInterior(world, ox + dx * i, by + h, oz + dz * i)) { clear = false; break; }
      }
      if (!clear) break;
      if (world.getBlock(ox - dx, by + h, oz - dz) !== OBS) { ok = false; break; }
      if (world.getBlock(ox + dx * w, by + h, oz + dz * w) !== OBS) { ok = false; break; }
      h++;
    }
    if (!ok || h < 3 || h > 21) continue;
    for (let i = 0; i < w && ok; i++) {
      if (world.getBlock(ox + dx * i, by + h, oz + dz * i) !== OBS) ok = false;
    }
    if (!ok) continue;
    const meta = axis === 0 ? 1 : 2;   // portal axis stored in metadata
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) world.setBlock(ox + dx * i, by + j, oz + dz * i, PORTAL, meta);
    }
    playSoundAt(x, y, z, 'portal_trigger', 1, 1);
    return true;
  }
  return false;
}

function igniteUse(consumeInstead) {
  return (world, player, stack, hit) => {
    if (!hit) return false;
    const target = bname(world, hit.x, hit.y, hit.z);
    if (target === 'tnt') {
      world.setBlock(hit.x, hit.y, hit.z, 0, 0);
      withMod(MOD.itementity, (m) => {
        if (m.TNTEntity) {
          const t = new m.TNTEntity(world, hit.x + 0.5, hit.y, hit.z + 0.5);
          world.addEntity(t);
        }
      });
      playSoundAt(hit.x, hit.y, hit.z, 'fuse', 1, 1);
      if (consumeInstead) shrink(player, stack, 1); else damageItem(player, stack, 1);
      return true;
    }
    if (target === 'obsidian' || target === 'crying_obsidian') {
      const p = offsetHit(hit);
      if (tryLightPortal(world, p.x, p.y, p.z)) {
        if (consumeInstead) shrink(player, stack, 1); else damageItem(player, stack, 1);
        return true;
      }
    }
    if (target === 'candle' || target.endsWith('_candle')) {
      const meta = world.getMeta(hit.x, hit.y, hit.z);
      world.setBlock(hit.x, hit.y, hit.z, bid(target), (meta | 8) & 15);
      playSoundAt(hit.x, hit.y, hit.z, 'fire', 1, 1);
      if (consumeInstead) shrink(player, stack, 1); else damageItem(player, stack, 1);
      return true;
    }
    const p = offsetHit(hit);
    if (!replaceableAt(world, p.x, p.y, p.z)) return false;
    const below = bname(world, p.x, p.y - 1, p.z);
    const soul = below === 'soul_sand' || below === 'soul_soil';
    world.setBlock(p.x, p.y, p.z, bid(soul ? 'soul_fire' : 'fire'), 0);
    playSoundAt(p.x, p.y, p.z, 'flint_and_steel', 1, 0.9 + Math.random() * 0.2);
    if (consumeInstead) shrink(player, stack, 1); else damageItem(player, stack, 1);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Shears
// ---------------------------------------------------------------------------

const SHEARABLE_BLOCKS = new Set([
  'vine', 'glow_lichen', 'cobweb', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'seagrass', 'tall_seagrass', 'nether_sprouts', 'twisting_vines', 'weeping_vines', 'hanging_roots',
  'sculk_vein', 'moss_carpet', 'small_dripleaf', 'big_dripleaf',
]);

function shearsUse(world, player, stack, hit) {
  if (!hit) return false;
  const name = bname(world, hit.x, hit.y, hit.z);
  if (name === 'pumpkin') {
    const face = hit.face >= 2 ? hit.face : 3;
    const facing = face === 2 ? 0 : face === 5 ? 1 : face === 3 ? 2 : 3;
    world.setBlock(hit.x, hit.y, hit.z, bid('carved_pumpkin'), facing);
    dropAt(world, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 'pumpkin_seeds', 4);
    playSoundAt(hit.x, hit.y, hit.z, 'shear', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  if (name === 'beehive' || name === 'bee_nest') {
    dropAt(world, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 'honeycomb', 3);
    world.setBlock(hit.x, hit.y, hit.z, bid(name), 0);
    playSoundAt(hit.x, hit.y, hit.z, 'shear', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  if (name.endsWith('_leaves') || SHEARABLE_BLOCKS.has(name)) {
    world.setBlock(hit.x, hit.y, hit.z, 0, 0);
    dropAt(world, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, name, 1);
    playSoundAt(hit.x, hit.y, hit.z, 'shear', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  return false;
}

function shearsUseOnEntity(world, player, stack, entity) {
  if (!entity || !entity.type) return false;
  if (entity.type === 'sheep' && !entity.sheared && !entity.baby) {
    entity.sheared = true;
    const color = entity.woolColor || 'white';
    const n = 1 + Math.floor(Math.random() * 3);
    dropAt(world, entity.x, entity.y + 0.5, entity.z, `${color}_wool`, n);
    playSoundAt(entity.x, entity.y, entity.z, 'sheep_shear', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  if (entity.type === 'mooshroom') {
    dropAt(world, entity.x, entity.y + 0.5, entity.z, entity.variant === 'brown' ? 'brown_mushroom' : 'red_mushroom', 5);
    withMod(MOD.mobs, (m) => {
      const cow = m.createMob('cow', world, entity.x, entity.y, entity.z);
      if (cow) { cow.health = entity.health; entity.remove(); }
    });
    playSoundAt(entity.x, entity.y, entity.z, 'sheep_shear', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  if (entity.type === 'snow_golem' && !entity.sheared) {
    entity.sheared = true;
    damageItem(player, stack, 1);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bone meal
// ---------------------------------------------------------------------------

const SAPLING_FEATURE = {
  oak_sapling: 'oak_tree', spruce_sapling: 'spruce_tree', birch_sapling: 'birch_tree',
  jungle_sapling: 'jungle_tree', acacia_sapling: 'acacia_tree', dark_oak_sapling: 'dark_oak_tree',
  cherry_sapling: 'cherry_tree', mangrove_propagule: 'mangrove_tree', azalea: 'azalea_tree',
  flowering_azalea: 'azalea_tree', crimson_fungus: 'crimson_fungus_tree', warped_fungus: 'warped_fungus_tree',
  brown_mushroom: 'huge_brown_mushroom', red_mushroom: 'huge_red_mushroom',
};
const GROWABLE_CROPS = new Set(['wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem',
  'torchflower_crop', 'pitcher_crop', 'nether_wart', 'sweet_berry_bush', 'cocoa']);
const BONEMEAL_FLOWERS = ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower',
  'blue_orchid', 'allium', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'lily_of_the_valley'];

function boneMealUse(world, player, stack, hit) {
  if (!hit) return false;
  const x = hit.x, y = hit.y, z = hit.z;
  const name = bname(world, x, y, z);
  const meta = world.getMeta(x, y, z);

  const feature = SAPLING_FEATURE[name];
  if (feature) {
    if (Math.random() < 0.45) {
      withMod(MOD.features, (m) => {
        world.setBlock(x, y, z, 0, 0);
        if (!m.placeFeature(feature, world, x, y, z, Math.random, {})) world.setBlock(x, y, z, bid(name), meta);
      });
    }
    boneMealEffect(world, x, y, z);
    shrink(player, stack, 1);
    return true;
  }
  if (GROWABLE_CROPS.has(name)) {
    const max = name === 'cocoa' ? 2 : name === 'beetroots' || name === 'nether_wart' || name === 'sweet_berry_bush' ? 3 : 7;
    const stage = meta & (max === 3 ? 3 : 7);
    if (stage >= max) return false;
    const grow = 2 + Math.floor(Math.random() * 4);
    // Keep any high meta bits (cocoa stores its facing there); writing the bare
    // stage would erase it and the pod would pop off.
    world.setBlock(x, y, z, bid(name), (meta & ~(max === 3 ? 3 : 7)) | Math.min(max, stage + grow));
    boneMealEffect(world, x, y, z);
    shrink(player, stack, 1);
    return true;
  }
  if (name === 'bamboo' || name === 'sugar_cane' || name === 'cactus' || name === 'kelp' || name === 'twisting_vines' || name === 'weeping_vines') {
    let top = y;
    while (bname(world, x, top + 1, z) === name) top++;
    for (let i = 1; i <= 2; i++) {
      if (!replaceableAt(world, x, top + i, z)) break;
      world.setBlock(x, top + i, z, bid(name), 0);
    }
    boneMealEffect(world, x, top, z);
    shrink(player, stack, 1);
    return true;
  }
  if (name === 'grass_block' || name === 'moss_block' || name === 'podzol' || name === 'mycelium' || name === 'dirt') {
    let placed = 0;
    for (let i = 0; i < 48; i++) {
      const px = x + Math.floor(Math.random() * 7) - 3;
      const pz = z + Math.floor(Math.random() * 7) - 3;
      const py = y + Math.floor(Math.random() * 3) - 1;
      if (!replaceableAt(world, px, py + 1, pz)) continue;
      const under = bname(world, px, py, pz);
      if (under !== 'grass_block' && under !== 'moss_block' && under !== 'dirt') continue;
      const roll = Math.random();
      const put = roll < 0.12 ? BONEMEAL_FLOWERS[Math.floor(Math.random() * BONEMEAL_FLOWERS.length)] : 'short_grass';
      world.setBlock(px, py + 1, pz, bid(put), 0);
      placed++;
      if (placed > 14) break;
    }
    boneMealEffect(world, x, y + 1, z);
    shrink(player, stack, 1);
    return placed > 0;
  }
  if (name === 'sea_pickle') {
    const n = Math.min(3, (meta & 3) + 1);
    world.setBlock(x, y, z, bid(name), n);
    boneMealEffect(world, x, y, z);
    shrink(player, stack, 1);
    return true;
  }
  return false;
}

function boneMealEffect(world, x, y, z) {
  particles('magic', x + 0.5, y + 0.6, z + 0.5, { count: 15, spread: 0.6, color: 0x77dd44 });
  playSoundAt(x, y, z, 'bone_meal', 0.8, 1);
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

const FLUID_BUCKETS = { water: 'water_bucket', lava: 'lava_bucket', powder_snow: 'powder_snow_bucket' };

function emptyBucketUse(world, player, stack) {
  const eye = eyeOf(player);
  const d = lookVec(player);
  const hit = world.raycast(eye.x, eye.y, eye.z, d.x, d.y, d.z, player.getReach ? player.getReach() : 4.5, { fluids: true });
  if (!hit) return false;
  const name = bname(world, hit.x, hit.y, hit.z);
  const filled = FLUID_BUCKETS[name];
  if (!filled) return false;
  if ((name === 'water' || name === 'lava') && (world.getMeta(hit.x, hit.y, hit.z) & 7) !== 0) return false;  // flowing, not a source
  world.setBlock(hit.x, hit.y, hit.z, 0, 0);
  replaceStack(player, stack, filled);
  playSound(player, name === 'lava' ? 'bucket_fill_lava' : 'bucket_fill', 1, 1);
  return true;
}

function fluidBucketUse(fluidName, mobName) {
  return (world, player, stack, hit) => {
    if (!hit) return false;
    let p = replaceableAt(world, hit.x, hit.y, hit.z) ? { x: hit.x, y: hit.y, z: hit.z } : offsetHit(hit);
    if (!replaceableAt(world, p.x, p.y, p.z)) return false;
    world.setBlock(p.x, p.y, p.z, bid(fluidName), 0);
    if (mobName) {
      withMod(MOD.mobs, (m) => {
        const e = m.createMob(mobName, world, p.x + 0.5, p.y + 0.2, p.z + 0.5);
        if (e && stack.fishVariant !== undefined) e.variant = stack.fishVariant;
      });
    }
    if (!isCreative(player)) replaceStack(player, stack, 'bucket');
    playSound(player, fluidName === 'lava' ? 'bucket_empty_lava' : 'bucket_empty', 1, 1);
    return true;
  };
}

function milkFinish(world, player, stack) {
  if (player.effects && player.effects.clear) {
    for (const key of Array.from(player.effects.keys())) player.removeEffect(key);
  }
  shrink(player, stack, 1);
  giveOrDrop(player, mkStack('bucket', 1));
  playSound(player, 'burp', 0.5, 1);
  return true;
}

// ---------------------------------------------------------------------------
// Ranged weapons
// ---------------------------------------------------------------------------

const ARROW_NAMES = ['arrow', 'spectral_arrow', 'tipped_arrow'];

/** True when `name` is any kind of arrow, including the 40-odd tipped variants. */
function isArrowItem(name) {
  return name === 'arrow' || name === 'spectral_arrow' || name === 'tipped_arrow' || name.startsWith('tipped_arrow_');
}

/** First inventory slot holding one of `names` (or any arrow, when `arrows` is set). */
function findAmmoSlot(player, names, arrows) {
  const inv = player && player.inventory;
  if (!inv) return -1;
  for (let i = 0; i < inv.size; i++) {
    const s = inv.get(i);
    if (!s || !s.item || s.count <= 0) continue;
    if (arrows && isArrowItem(s.item)) return i;
    if (names && names.indexOf(s.item) >= 0) return i;
  }
  return -1;
}
function hasAmmo(player, names) {
  if (isCreative(player)) return true;
  return findAmmoSlot(player, names, names.indexOf('arrow') >= 0) >= 0;
}
function takeAmmo(player, names) {
  if (isCreative(player)) return names[0];
  const i = findAmmoSlot(player, names, names.indexOf('arrow') >= 0);
  if (i < 0) return null;
  const inv = player.inventory;
  const s = inv.get(i);
  const name = s.item;
  s.count -= 1;
  if (s.count <= 0) inv.set(i, null);
  else inv.set(i, s);
  return name;
}

/** Maps an arrow item name onto its projectile type. */
function arrowProjectile(name) {
  if (name === 'spectral_arrow') return 'spectral_arrow';
  if (name === 'tipped_arrow' || name.startsWith('tipped_arrow_')) return 'tipped_arrow';
  return 'arrow';
}

const bowUse = (world, player, stack) => {
  if (!hasAmmo(player, ARROW_NAMES)) return false;
  player.usingItem = stack;
  player.useTicks = 0;
  player.useDuration = 72000;
  return true;
};

/** Bow release: charge time maps to arrow power exactly like vanilla. */
const bowStop = (world, player, stack, ticksUsed) => {
  const t = (ticksUsed || 0) / 20;
  let power = (t * t + t * 2) / 3;
  if (power < 0.1) return false;
  power = Math.min(1, power);
  const ammo = takeAmmo(player, ARROW_NAMES);
  if (!ammo) return false;
  const eye = eyeOf(player);
  const d = lookVec(player);
  const speed = power * 3;
  withMod(MOD.combat, (m) => {
    if (m.shootArrow) m.shootArrow(world, player, power, { type: arrowProjectile(ammo), critical: power >= 1, item: ammo });
    else withMod(MOD.projectiles, (p) => p.spawnProjectile(arrowProjectile(ammo), world, player, eye.x, eye.y, eye.z, d.x * speed, d.y * speed, d.z * speed, { power, critical: power >= 1, item: ammo }));
  });
  playSound(player, 'bow', 1, 1 / (Math.random() * 0.4 + 1.2) + power * 0.5);
  damageItem(player, stack, 1);
  return true;
};

const crossbowUse = (world, player, stack) => {
  if (stack.charged) {
    const ammo = stack.chargedItem || 'arrow';
    const eye = eyeOf(player);
    const d = lookVec(player);
    const speed = ammo === 'firework_rocket' ? 1.6 : 3.15;
    withMod(MOD.projectiles, (m) => m.spawnProjectile(ammo === 'firework_rocket' ? 'firework_rocket' : arrowProjectile(ammo), world, player,
      eye.x, eye.y, eye.z, d.x * speed, d.y * speed, d.z * speed, { power: 1, critical: false, item: ammo }));
    stack.charged = false;
    stack.chargedItem = null;
    playSound(player, 'crossbow_shoot', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  if (!hasAmmo(player, ARROW_NAMES.concat(['firework_rocket']))) return false;
  player.usingItem = stack;
  player.useTicks = 0;
  player.useDuration = 25;
  return true;
};

const crossbowFinish = (world, player, stack) => {
  const ammo = takeAmmo(player, ARROW_NAMES.concat(['firework_rocket']));
  if (!ammo) return false;
  stack.charged = true;
  stack.chargedItem = ammo;
  playSound(player, 'crossbow_load', 1, 1);
  return true;
};

const tridentUse = (world, player, stack) => {
  player.usingItem = stack;
  player.useTicks = 0;
  player.useDuration = 72000;
  return true;
};
const tridentStop = (world, player, stack, ticksUsed) => {
  if ((ticksUsed || 0) < 10) return false;
  const eye = eyeOf(player);
  const d = lookVec(player);
  const speed = 2.5;
  withMod(MOD.projectiles, (m) => m.spawnProjectile('trident', world, player, eye.x, eye.y, eye.z, d.x * speed, d.y * speed, d.z * speed, { item: stack.item, loyalty: stack.loyalty || 0 }));
  shrink(player, stack, 1);
  playSound(player, 'trident_throw', 1, 1);
  return true;
};

const fishingRodUse = (world, player, stack) => {
  if (player.bobber && !player.bobber.removed) {
    player.bobber.remove();
    player.bobber = null;
    playSound(player, 'fishing_retrieve', 1, 1);
    damageItem(player, stack, 1);
    return true;
  }
  const eye = eyeOf(player);
  const d = lookVec(player);
  withMod(MOD.projectiles, (m) => {
    const b = m.spawnProjectile('fishing_bobber', world, player, eye.x, eye.y, eye.z, d.x * 1.5, d.y * 1.5, d.z * 1.5, {});
    if (b) player.bobber = b;
  });
  playSound(player, 'fishing_cast', 0.5, 1);
  return true;
};

// ---------------------------------------------------------------------------
// Spawn eggs, vehicles and the rest of the interactive odds and ends
// ---------------------------------------------------------------------------

function spawnEggUse(mobName) {
  return (world, player, stack, hit) => {
    if (!hit) return false;
    const p = offsetHit(hit);
    withMod(MOD.mobs, (m) => {
      const e = m.createMob(mobName, world, p.x + 0.5, p.y, p.z + 0.5, { persistent: true });
      if (e && e.yaw !== undefined) e.yaw = player.yaw;
    });
    shrink(player, stack, 1);
    return true;
  };
}

function spawnEggUseOnEntity(mobName) {
  return (world, player, stack, entity) => {
    // Vanilla behaviour: an egg matching the mob spawns a baby of the same type.
    if (!entity || entity.type !== mobName) return false;
    withMod(MOD.mobs, (m) => m.createMob(mobName, world, entity.x, entity.y, entity.z, { baby: true, persistent: true }));
    shrink(player, stack, 1);
    return true;
  };
}

function vehicleUse(type, variant) {
  return (world, player, stack, hit) => {
    if (!hit) return false;
    const onRail = bname(world, hit.x, hit.y, hit.z).endsWith('rail');
    const p = onRail ? { x: hit.x, y: hit.y, z: hit.z } : offsetHit(hit);
    if (type.indexOf('minecart') >= 0 && !onRail) return false;
    withMod(MOD.vehicles, (m) => {
      const v = m.spawnVehicle(type, world, p.x + 0.5, p.y + (onRail ? 0.1 : 0), p.z + 0.5);
      if (v) { if (variant) v.variant = variant; if (v.yaw !== undefined) v.yaw = player.yaw; }
    });
    playSoundAt(p.x, p.y, p.z, type.indexOf('boat') >= 0 || type.indexOf('raft') >= 0 ? 'boat_place' : 'minecart_place', 1, 1);
    shrink(player, stack, 1);
    return true;
  };
}

const nameTagUseOnEntity = (world, player, stack, entity) => {
  if (!entity || entity.type === 'player' || entity.type === 'ender_dragon') return false;
  const name = (stack.customName || stack.displayName || '').trim();
  if (!name) return false;
  entity.customName = name;
  entity.persistent = true;
  shrink(player, stack, 1);
  return true;
};

const leadUseOnEntity = (world, player, stack, entity) => {
  if (!entity || entity.type === 'player') return false;
  if (entity.leashedTo === player) { entity.leashedTo = null; giveOrDrop(player, mkStack('lead', 1)); return true; }
  entity.leashedTo = player;
  shrink(player, stack, 1);
  return true;
};

const saddleUseOnEntity = (world, player, stack, entity) => {
  if (!entity) return false;
  const rideable = ['pig', 'strider', 'horse', 'donkey', 'mule', 'zombie_horse', 'skeleton_horse', 'camel'];
  if (rideable.indexOf(entity.type) < 0 || entity.saddled) return false;
  entity.saddled = true;
  playSoundAt(entity.x, entity.y, entity.z, 'saddle', 1, 1);
  shrink(player, stack, 1);
  return true;
};

function horseArmorUseOnEntity(armorName) {
  return (world, player, stack, entity) => {
    if (!entity || (entity.type !== 'horse' && entity.type !== 'zombie_horse' && entity.type !== 'skeleton_horse')) return false;
    if (entity.horseArmor) return false;
    entity.horseArmor = armorName;
    playSoundAt(entity.x, entity.y, entity.z, 'equip_armor', 1, 1);
    shrink(player, stack, 1);
    return true;
  };
}

function dyeUseOnEntity(color, hex) {
  return (world, player, stack, entity) => {
    if (!entity) return false;
    if (entity.type === 'sheep') {
      if (entity.woolColor === color) return false;
      entity.woolColor = color;
      shrink(player, stack, 1);
      return true;
    }
    if (entity.type === 'wolf' || entity.type === 'cat') {
      if (!entity.tamed) return false;
      entity.collarColor = hex;
      shrink(player, stack, 1);
      return true;
    }
    if (entity.type === 'shulker') { entity.color = color; shrink(player, stack, 1); return true; }
    return false;
  };
}

const fireworkUse = (world, player, stack) => {
  if (player.elytraFlying) {
    // Firework boost while gliding.
    const d = lookVec(player);
    const boost = 1.5 + (stack.flightDuration || 1) * 0.4;
    player.vx += d.x * boost; player.vy += d.y * boost; player.vz += d.z * boost;
    shrink(player, stack, 1);
    playSound(player, 'firework_launch', 1, 1);
    return true;
  }
  return false;
};
const fireworkPlace = (world, player, stack, hit) => {
  if (!hit) return false;
  const p = offsetHit(hit);
  withMod(MOD.projectiles, (m) => m.spawnProjectile('firework_rocket', world, player, p.x + 0.5, p.y + 0.1, p.z + 0.5, 0, 0.05, 0, {
    flight: stack.flightDuration || 1, colors: stack.colors || null,
  }));
  playSoundAt(p.x, p.y, p.z, 'firework_launch', 1, 1);
  shrink(player, stack, 1);
  return true;
};

const endCrystalPlace = (world, player, stack, hit) => {
  if (!hit) return false;
  const base = bname(world, hit.x, hit.y, hit.z);
  if (base !== 'obsidian' && base !== 'bedrock') return false;
  const p = { x: hit.x, y: hit.y + 1, z: hit.z };
  if (!replaceableAt(world, p.x, p.y, p.z) || !replaceableAt(world, p.x, p.y + 1, p.z)) return false;
  withMod(MOD.projectiles, (m) => {
    if (m.spawnProjectile) m.spawnProjectile('end_crystal', world, player, p.x + 0.5, p.y, p.z + 0.5, 0, 0, 0, { showBase: true });
  });
  shrink(player, stack, 1);
  return true;
};

const glassBottleUse = (world, player, stack) => {
  const eye = eyeOf(player);
  const d = lookVec(player);
  const hit = world.raycast(eye.x, eye.y, eye.z, d.x, d.y, d.z, 4.5, { fluids: true });
  if (!hit) return false;
  const name = bname(world, hit.x, hit.y, hit.z);
  if (name !== 'water' && name !== 'water_cauldron') return false;
  if (name === 'water_cauldron') {
    const lvl = world.getMeta(hit.x, hit.y, hit.z) & 3;
    if (lvl <= 1) world.setBlock(hit.x, hit.y, hit.z, bid('cauldron'), 0);
    else world.setBlock(hit.x, hit.y, hit.z, bid('water_cauldron'), lvl - 1);
  }
  replaceStack(player, stack, 'potion_water');
  playSound(player, 'bottle_fill', 1, 1);
  return true;
};

const POTTERY_SHERDS = ['angler', 'archer', 'arms_up', 'blade', 'brewer', 'burn', 'danger', 'explorer',
  'friend', 'heart', 'heartbreak', 'howl', 'miner', 'mourner', 'plenty', 'prize', 'sheaf', 'shelter',
  'skull', 'snort'];

const brushUse = (world, player, stack, hit) => {
  if (!hit) return false;
  const name = bname(world, hit.x, hit.y, hit.z);
  if (name !== 'suspicious_sand' && name !== 'suspicious_gravel') return false;
  world.setBlock(hit.x, hit.y, hit.z, bid(name === 'suspicious_sand' ? 'sand' : 'gravel'), 0);
  const roll = Math.random();
  const loot = roll < 0.35
    ? POTTERY_SHERDS[Math.floor(Math.random() * POTTERY_SHERDS.length)] + '_pottery_sherd'
    : roll < 0.6 ? 'emerald' : roll < 0.75 ? 'diamond' : roll < 0.9 ? 'iron_ingot' : 'wheat';
  dropAt(world, hit.x + 0.5, hit.y + 0.7, hit.z + 0.5, loot, 1);
  playSoundAt(hit.x, hit.y, hit.z, 'brush', 1, 1);
  damageItem(player, stack, 1);
  return true;
};

const armorStandPlace = (world, player, stack, hit) => {
  if (!hit) return false;
  const p = offsetHit(hit);
  if (!replaceableAt(world, p.x, p.y, p.z)) return false;
  withMod(MOD.mobs, (m) => {
    const e = m.createMob('armor_stand', world, p.x + 0.5, p.y, p.z + 0.5, { persistent: true });
    if (e && e.yaw !== undefined) e.yaw = player.yaw + Math.PI;
  });
  shrink(player, stack, 1);
  return true;
};

const spyglassUse = (world, player, stack) => {
  player.usingItem = stack;
  player.useTicks = 0;
  player.useDuration = 1200;
  player.zooming = true;
  return true;
};
const spyglassStop = (world, player) => { player.zooming = false; return true; };

const shieldUse = (world, player, stack) => {
  player.usingItem = stack;
  player.useTicks = 0;
  player.useDuration = 72000;
  player.blocking = true;
  return true;
};
const shieldStop = (world, player) => { player.blocking = false; return true; };

const mapUse = (world, player, stack) => {
  replaceStack(player, stack, 'filled_map');
  return true;
};

const goatHornUse = (world, player, stack) => {
  playSound(player, 'goat_horn', 4, 1);
  player.hornCooldown = 140;
  return true;
};

const enderEyeUse = (world, player, stack, hit) => {
  if (hit && bname(world, hit.x, hit.y, hit.z) === 'end_portal_frame') {
    const meta = world.getMeta(hit.x, hit.y, hit.z);
    if (meta & 4) return false;
    world.setBlock(hit.x, hit.y, hit.z, bid('end_portal_frame'), meta | 4);
    shrink(player, stack, 1);
    playSoundAt(hit.x, hit.y, hit.z, 'end_portal_frame_fill', 1, 1);
    return true;
  }
  const eye = eyeOf(player);
  withMod(MOD.projectiles, (m) => m.spawnProjectile('eye_of_ender', world, player, eye.x, eye.y, eye.z, 0, 0.3, 0, {}));
  shrink(player, stack, 1);
  return true;
};

const chorusFruitFinish = (world, player, stack) => {
  finishEating(world, player, stack);
  for (let i = 0; i < 16; i++) {
    const tx = player.x + (Math.random() - 0.5) * 16;
    const tz = player.z + (Math.random() - 0.5) * 16;
    const ty = Math.floor(player.y + (Math.random() - 0.5) * 16);
    if (world.isAir(Math.floor(tx), ty, Math.floor(tz)) && world.isSolid(Math.floor(tx), ty - 1, Math.floor(tz))) {
      if (player.teleport) player.teleport(tx, ty, tz);
      else { player.x = tx; player.y = ty; player.z = tz; }
      playSound(player, 'chorus_teleport', 1, 1);
      break;
    }
  }
  return true;
};

const honeyBottleFinish = (world, player, stack) => {
  if (player.removeEffect) player.removeEffect('poison');
  finishEating(world, player, stack);
  return true;
};

const potionUse = drinkUse;
function potionFinish(typeId) {
  return (world, player, stack) => {
    const t = POTION_BY_ID[typeId];
    if (t) {
      for (const [name, ticks, level] of t.effects) {
        if (name === 'instant_health' && player.heal) player.heal(4 * Math.pow(2, level));
        else if (name === 'instant_damage' && player.hurt) player.hurt(6 * Math.pow(2, level), null);
        else if (player.addEffect) player.addEffect(name, ticks, level);
      }
    }
    playSound(player, 'drink', 0.5, 1);
    shrink(player, stack, 1);
    giveOrDrop(player, mkStack('glass_bottle', 1));
    return true;
  };
}

// ===========================================================================
// 1. Tools and weapons
// ===========================================================================

const TOOL_MATERIALS = [
  { key: 'wooden', tier: 0, durability: 59, speed: 2, matDmg: 0, axeDmg: 7, axeSpeed: 0.8, hoeSpeed: 1, ench: 15, repair: 'oak_planks', fuel: 200 },
  { key: 'stone', tier: 1, durability: 131, speed: 4, matDmg: 1, axeDmg: 9, axeSpeed: 0.8, hoeSpeed: 2, ench: 5, repair: 'cobblestone', fuel: 0 },
  { key: 'iron', tier: 2, durability: 250, speed: 6, matDmg: 2, axeDmg: 9, axeSpeed: 0.9, hoeSpeed: 3, ench: 14, repair: 'iron_ingot', fuel: 0 },
  { key: 'golden', tier: 0, durability: 32, speed: 12, matDmg: 0, axeDmg: 7, axeSpeed: 1.0, hoeSpeed: 1, ench: 22, repair: 'gold_ingot', fuel: 0 },
  { key: 'diamond', tier: 3, durability: 1561, speed: 8, matDmg: 3, axeDmg: 9, axeSpeed: 1.0, hoeSpeed: 4, ench: 10, repair: 'diamond', fuel: 0 },
  { key: 'netherite', tier: 4, durability: 2031, speed: 9, matDmg: 4, axeDmg: 10, axeSpeed: 1.0, hoeSpeed: 4, ench: 15, repair: 'netherite_ingot', fuel: 0 },
];

/**
 * Registers sword / pickaxe / axe / shovel / hoe for one material with vanilla
 * damage, speed and attack-speed numbers.
 */
function defineToolSet(material, tier, durability, speed, damage, enchantability, repairWith) {
  const m = TOOL_MATERIALS.find((t) => t.key === material) || TOOL_MATERIALS[0];
  const fuel = m.fuel;
  const rare = material === 'netherite' ? 'rare' : 'common';
  const base = { group: 'tools', stack: 1, enchantability, repairWith, rarity: rare, fuel };

  defineItem(`${material}_sword`, {
    ...base, group: 'combat',
    tool: { kind: 'sword', tier, durability, speed, damage, attackSpeed: 1.6 },
    onHitEntity: (attacker, target, stack) => { damageItem(attacker, stack, 1); return false; },
  });
  defineItem(`${material}_pickaxe`, {
    ...base,
    tool: { kind: 'pickaxe', tier, durability, speed, damage: m.matDmg + 2, attackSpeed: 1.2 },
  });
  defineItem(`${material}_axe`, {
    ...base,
    tool: { kind: 'axe', tier, durability, speed, damage: m.axeDmg, attackSpeed: m.axeSpeed },
    onUseOnBlock: axeUse,
  });
  defineItem(`${material}_shovel`, {
    ...base,
    tool: { kind: 'shovel', tier, durability, speed, damage: m.matDmg + 2.5, attackSpeed: 1.0 },
    onUseOnBlock: shovelUse,
  });
  defineItem(`${material}_hoe`, {
    ...base,
    tool: { kind: 'hoe', tier, durability, speed, damage: 1, attackSpeed: m.hoeSpeed },
    onUseOnBlock: hoeUse,
  });
}

for (const m of TOOL_MATERIALS) {
  defineToolSet(m.key, m.tier, m.durability, m.speed, m.matDmg + 4, m.ench, m.repair);
}

// ===========================================================================
// 2. Armour
// ===========================================================================

const ARMOR_PIECES = [
  { suffix: 'helmet', slot: 'head', index: 0, mult: 11 },
  { suffix: 'chestplate', slot: 'chest', index: 1, mult: 16 },
  { suffix: 'leggings', slot: 'legs', index: 2, mult: 15 },
  { suffix: 'boots', slot: 'feet', index: 3, mult: 13 },
];

/**
 * Registers the four armour pieces for one material.
 * `defensePerSlot` is [helmet, chestplate, leggings, boots].
 * `durabilityBase` is the vanilla per-material factor (leather 5 .. netherite 37).
 */
function defineArmorSet(material, defensePerSlot, toughness, durabilityBase, knockbackResist, enchantability = 10, repairWith = null) {
  ARMOR_PIECES.forEach((p, i) => {
    defineItem(`${material}_${p.suffix}`, {
      group: 'combat', stack: 1,
      rarity: material === 'netherite' ? 'rare' : 'common',
      enchantability, repairWith,
      armor: {
        slot: p.slot, index: p.index, defense: defensePerSlot[i], toughness,
        durability: durabilityBase * p.mult, knockbackResist,
      },
      onUse: equipHandler(p.index),
    });
  });
}

defineArmorSet('leather', [1, 3, 2, 1], 0, 5, 0, 15, 'leather');
defineArmorSet('chainmail', [2, 5, 4, 1], 0, 15, 0, 12, 'iron_ingot');
defineArmorSet('iron', [2, 6, 5, 2], 0, 15, 0, 9, 'iron_ingot');
defineArmorSet('golden', [2, 5, 3, 1], 0, 7, 0, 25, 'gold_ingot');
defineArmorSet('diamond', [3, 8, 6, 3], 2, 33, 0, 10, 'diamond');
defineArmorSet('netherite', [3, 8, 6, 3], 3, 37, 0.1, 15, 'netherite_ingot');

defineItem('turtle_helmet', {
  group: 'combat', stack: 1, enchantability: 9, repairWith: 'scute',
  armor: { slot: 'head', index: 0, defense: 2, toughness: 0, durability: 275, knockbackResist: 0 },
  onUse: equipHandler(0),
});
defineItem('elytra', {
  group: 'combat', stack: 1, rarity: 'epic', enchantability: 1, repairWith: 'phantom_membrane',
  armor: { slot: 'chest', index: 1, defense: 0, toughness: 0, durability: 432, knockbackResist: 0 },
  onUse: equipHandler(1),
});

// ===========================================================================
// 3. Combat and ranged
// ===========================================================================

defineItem('bow', {
  group: 'combat', stack: 1, durability: 384, enchantability: 1, repairWith: 'string', fuel: 300,
  useAction: 'bow', useDuration: 72000,
  onUse: bowUse, onStopUsing: bowStop,
});
defineItem('crossbow', {
  group: 'combat', stack: 1, durability: 465, enchantability: 1, repairWith: 'string', fuel: 300,
  useAction: 'crossbow', useDuration: 25,
  onUse: crossbowUse, onFinishUsing: crossbowFinish,
});
defineItem('arrow', { group: 'combat', projectile: 'arrow' });
defineItem('spectral_arrow', { group: 'combat', projectile: 'spectral_arrow' });
defineItem('trident', {
  group: 'combat', stack: 1, durability: 250, enchantability: 1, rarity: 'rare',
  tool: { kind: 'trident', tier: 2, durability: 250, speed: 1, damage: 9, attackSpeed: 1.1 },
  useAction: 'bow', useDuration: 72000,
  onUse: tridentUse, onStopUsing: tridentStop,
});
defineItem('shield', {
  group: 'combat', stack: 1, durability: 336, repairWith: '#planks', fuel: 200,
  useAction: 'block', useDuration: 72000,
  onUse: shieldUse, onStopUsing: shieldStop,
});
defineItem('totem_of_undying', { group: 'combat', stack: 1, rarity: 'uncommon' });
defineItem('firework_star', { group: 'misc' });
defineItem('firework_rocket', { group: 'misc', onUse: fireworkUse, onUseOnBlock: fireworkPlace });
defineItem('fire_charge', { group: 'combat', onUseOnBlock: igniteUse(true) });
defineItem('wind_charge', { group: 'combat', stack: 64, onUse: throwHandler('wind_charge', 1.5, 'wind_charge_throw') });
defineItem('end_crystal', { group: 'misc', rarity: 'rare', onUseOnBlock: endCrystalPlace });

// ===========================================================================
// 4. Tools that are not weapons
// ===========================================================================

defineItem('flint_and_steel', {
  group: 'tools', stack: 1, durability: 64, repairWith: 'iron_ingot',
  onUseOnBlock: igniteUse(false),
});
defineItem('shears', {
  group: 'tools', stack: 1, durability: 238, repairWith: 'iron_ingot',
  tool: { kind: 'shears', tier: 0, durability: 238, speed: 5, damage: 1, attackSpeed: 1 },
  onUseOnBlock: shearsUse, onUseOnEntity: shearsUseOnEntity,
});
defineItem('fishing_rod', {
  group: 'tools', stack: 1, durability: 64, repairWith: 'string', fuel: 300,
  onUse: fishingRodUse,
});
defineItem('carrot_on_a_stick', { group: 'tools', stack: 1, durability: 25, repairWith: 'carrot' });
defineItem('warped_fungus_on_a_stick', { group: 'tools', stack: 1, durability: 100, repairWith: 'warped_fungus' });
defineItem('brush', { group: 'tools', stack: 1, durability: 64, onUseOnBlock: brushUse });
defineItem('spyglass', { group: 'tools', stack: 1, useAction: 'spyglass', useDuration: 1200, onUse: spyglassUse, onStopUsing: spyglassStop });
defineItem('compass', { group: 'tools', stack: 64 });
defineItem('recovery_compass', { group: 'tools', stack: 64, rarity: 'uncommon' });
defineItem('clock', { group: 'tools', stack: 64 });
defineItem('map', { group: 'tools', stack: 64, onUse: mapUse });
defineItem('filled_map', { group: 'tools', stack: 64 });
defineItem('name_tag', { group: 'tools', stack: 64, onUseOnEntity: nameTagUseOnEntity });
defineItem('lead', { group: 'tools', stack: 64, onUseOnEntity: leadUseOnEntity });
defineItem('saddle', { group: 'tools', stack: 1, onUseOnEntity: saddleUseOnEntity });
for (const [mat, def] of [['leather', 3], ['iron', 5], ['golden', 7], ['diamond', 11]]) {
  defineItem(`${mat}_horse_armor`, {
    group: 'combat', stack: 1, armor: { slot: 'horse', index: -1, defense: def, toughness: 0, durability: 0, knockbackResist: 0 },
    onUseOnEntity: horseArmorUseOnEntity(`${mat}_horse_armor`),
  });
}
defineItem('armor_stand', { group: 'misc', stack: 16, onUseOnBlock: armorStandPlace });
defineItem('item_frame', { group: 'misc', stack: 64 });
defineItem('glow_item_frame', { group: 'misc', stack: 64 });
defineItem('painting', { group: 'misc', stack: 64 });
defineItem('goat_horn', { group: 'tools', stack: 1, useAction: 'toot', onUse: goatHornUse });
defineItem('debug_stick', { group: 'misc', stack: 1, rarity: 'epic' });
defineItem('knowledge_book', { group: 'misc', stack: 1, rarity: 'epic' });

// ===========================================================================
// 5. Ingredients, minerals and mob drops
// ===========================================================================

const ING = (name, extra = {}) => defineItem(name, { group: 'ingredients', ...extra });

ING('stick', { fuel: 100 });
ING('string', { block: 'tripwire' });
ING('leather');
ING('rabbit_hide');
ING('feather');
ING('flint');
ING('gunpowder');
ING('bone');
ING('bone_meal', { onUseOnBlock: boneMealUse });
ING('slimeball');
ING('honeycomb');
ING('sugar');
ING('clay_ball');
ING('brick');
ING('nether_brick');
ING('paper');
ING('ink_sac');
ING('glow_ink_sac');
ING('blaze_rod', { fuel: 2400 });
ING('blaze_powder');
ING('magma_cream');
ING('ghast_tear');
ING('ender_pearl', { stack: 16, onUse: throwHandler('ender_pearl', 1.5, 'throw') });
ING('ender_eye', { display: 'Eye of Ender', onUse: enderEyeUse, onUseOnBlock: enderEyeUse });
ING('nether_star', { rarity: 'epic', stack: 64 });
ING('phantom_membrane');
ING('prismarine_shard');
ING('prismarine_crystals');
ING('nautilus_shell');
ING('heart_of_the_sea', { rarity: 'uncommon' });
ING('shulker_shell');
ING('rabbit_foot');
ING('scute', { display: 'Turtle Scute' });
ING('turtle_scute', { display: 'Turtle Scute' });
ING('fermented_spider_eye');
ING('glistering_melon_slice');
ING('echo_shard', { rarity: 'uncommon' });
ING('disc_fragment_5', { display: 'Disc Fragment' });
ING('netherite_scrap', { rarity: 'uncommon' });
ING('netherite_ingot', { rarity: 'uncommon' });
ING('breeze_rod');
ING('dragon_breath', { rarity: 'uncommon' });
ING('popped_chorus_fruit');
ING('bundle', { stack: 1 });

// Ores, ingots, nuggets and gems.
ING('coal', { fuel: 1600 });
ING('charcoal', { fuel: 1600 });
ING('diamond');
ING('emerald');
ING('lapis_lazuli');
ING('quartz', { display: 'Nether Quartz' });
ING('amethyst_shard');
ING('iron_ingot');
ING('gold_ingot');
ING('copper_ingot');
ING('iron_nugget');
ING('gold_nugget');
ING('raw_iron');
ING('raw_copper');
ING('raw_gold');
ING('redstone', { block: 'redstone_wire', group: 'redstone' });
ING('glowstone_dust');

// ===========================================================================
// 6. Dyes
// ===========================================================================

COLORS.forEach((c, i) => {
  defineItem(`${c}_dye`, { group: 'ingredients', color: DYE_HEX[i], onUseOnEntity: dyeUseOnEntity(c, DYE_HEX[i]) });
});
defineItem('cocoa_beans', { group: 'ingredients', block: 'cocoa', color: 0x835432 });

// ===========================================================================
// 7. Seeds, crops and farming items
// ===========================================================================

defineItem('wheat_seeds', { group: 'ingredients', block: 'wheat' });
defineItem('melon_seeds', { group: 'ingredients', block: 'melon_stem' });
defineItem('pumpkin_seeds', { group: 'ingredients', block: 'pumpkin_stem' });
defineItem('beetroot_seeds', { group: 'ingredients', block: 'beetroots' });
defineItem('torchflower_seeds', { group: 'ingredients', block: 'torchflower_crop' });
defineItem('pitcher_pod', { group: 'ingredients', block: 'pitcher_crop' });
defineItem('wheat', { group: 'ingredients' });
defineItem('nether_wart', { group: 'brewing', block: 'nether_wart' });
defineItem('sweet_berries', { group: 'food', block: 'sweet_berry_bush', food: { hunger: 2, saturation: 0.4, eatTicks: 32, effects: [] }, onUse: FOOD_USE, onFinishUsing: FOOD_FINISH });
defineItem('glow_berries', { group: 'food', block: 'cave_vines', food: { hunger: 2, saturation: 0.4, eatTicks: 32, effects: [] }, onUse: FOOD_USE, onFinishUsing: FOOD_FINISH });
defineItem('bowl', { group: 'ingredients', fuel: 200 });

// ===========================================================================
// 8. Food
// ===========================================================================

/** Registers an edible item with vanilla hunger/saturation values. */
function defineFood(name, hunger, saturation, opts = {}) {
  return defineItem(name, {
    group: 'food',
    stack: opts.stack !== undefined ? opts.stack : 64,
    rarity: opts.rarity || 'common',
    block: opts.block || null,
    fuel: opts.fuel || 0,
    food: {
      hunger, saturation,
      eatTicks: opts.eatTicks || 32,
      effects: opts.effects || [],
      alwaysEdible: !!opts.alwaysEdible,
      meat: !!opts.meat,
      container: opts.container || null,
      heal: opts.heal || 0,
    },
    useAction: 'eat',
    useDuration: opts.eatTicks || 32,
    onUse: opts.onUse || FOOD_USE,
    onFinishUsing: opts.onFinishUsing || FOOD_FINISH,
  });
}

defineFood('apple', 4, 2.4);
defineFood('spider_eye', 2, 3.2, { effects: [['poison', 100, 0, 1]] });
defineFood('golden_carrot', 6, 14.4);
defineFood('golden_apple', 4, 9.6, {
  rarity: 'rare', alwaysEdible: true,
  effects: [['regeneration', 100, 1], ['absorption', 2400, 0]],
});
defineFood('enchanted_golden_apple', 4, 9.6, {
  rarity: 'epic', alwaysEdible: true,
  effects: [['regeneration', 400, 1], ['resistance', 6000, 0], ['fire_resistance', 6000, 0], ['absorption', 2400, 3]],
});
defineFood('bread', 5, 6.0);
defineFood('porkchop', 3, 1.8, { meat: true });
defineFood('cooked_porkchop', 8, 12.8, { meat: true });
defineFood('beef', 3, 1.8, { meat: true });
defineFood('cooked_beef', 8, 12.8, { meat: true });
defineFood('chicken', 2, 1.2, { meat: true, effects: [['hunger', 600, 0, 0.3]] });
defineFood('cooked_chicken', 6, 7.2, { meat: true });
defineFood('mutton', 2, 1.2, { meat: true });
defineFood('cooked_mutton', 6, 9.6, { meat: true });
defineFood('rabbit', 3, 1.8, { meat: true });
defineFood('cooked_rabbit', 5, 6.0, { meat: true });
defineFood('cod', 2, 0.4, { meat: true });
defineFood('cooked_cod', 5, 6.0, { meat: true });
defineFood('salmon', 2, 0.4, { meat: true });
defineFood('cooked_salmon', 6, 9.6, { meat: true });
defineFood('tropical_fish', 1, 0.2, { meat: true });
defineFood('pufferfish', 1, 0.2, { meat: true, effects: [['poison', 1200, 1], ['hunger', 300, 2], ['nausea', 300, 0]] });
defineFood('dried_kelp', 1, 0.6, { eatTicks: 16 });
defineFood('carrot', 3, 3.6, { block: 'carrots' });
defineFood('potato', 1, 0.6, { block: 'potatoes' });
defineFood('baked_potato', 5, 6.0);
defineFood('poisonous_potato', 2, 1.2, { effects: [['poison', 100, 0, 0.6]] });
defineFood('beetroot', 1, 1.2);
defineFood('beetroot_soup', 6, 7.2, { stack: 1, container: 'bowl' });
defineFood('mushroom_stew', 6, 7.2, { stack: 1, container: 'bowl' });
defineFood('suspicious_stew', 6, 7.2, { stack: 1, container: 'bowl', effects: [['blindness', 100, 0]] });
defineFood('rabbit_stew', 10, 12.0, { stack: 1, container: 'bowl' });
defineFood('melon_slice', 2, 1.2);
defineFood('cookie', 2, 0.4);
defineFood('pumpkin_pie', 8, 4.8);
defineFood('chorus_fruit', 4, 2.4, { alwaysEdible: true, onFinishUsing: chorusFruitFinish });
defineFood('rotten_flesh', 4, 0.8, { meat: true, effects: [['hunger', 600, 0, 0.8]] });
defineFood('honey_bottle', 6, 1.2, { stack: 16, container: 'glass_bottle', eatTicks: 40, onFinishUsing: honeyBottleFinish });
defineFood('milk_bucket', 0, 0, { stack: 1, alwaysEdible: true, onUse: drinkUse, onFinishUsing: milkFinish });
defineItem('ominous_bottle', { group: 'brewing', stack: 64, rarity: 'uncommon', useAction: 'drink', useDuration: 32, onUse: drinkUse, onFinishUsing: (world, player, stack) => { if (player.addEffect) player.addEffect('bad_omen', 6000, 0); shrink(player, stack, 1); return true; } });

// ===========================================================================
// 9. Buckets
// ===========================================================================

defineItem('bucket', { group: 'tools', stack: 16, onUse: emptyBucketUse });
defineItem('water_bucket', { group: 'tools', stack: 1, block: 'water', onUseOnBlock: fluidBucketUse('water', null) });
defineItem('lava_bucket', { group: 'tools', stack: 1, block: 'lava', fuel: 20000, onUseOnBlock: fluidBucketUse('lava', null) });
defineItem('powder_snow_bucket', { group: 'tools', stack: 1, block: 'powder_snow', onUseOnBlock: fluidBucketUse('powder_snow', null) });
for (const [item, mob] of [['cod_bucket', 'cod'], ['salmon_bucket', 'salmon'], ['tropical_fish_bucket', 'tropical_fish'],
  ['pufferfish_bucket', 'pufferfish'], ['axolotl_bucket', 'axolotl'], ['tadpole_bucket', 'tadpole']]) {
  defineItem(item, { group: 'tools', stack: 1, onUseOnBlock: fluidBucketUse('water', mob) });
}

// ===========================================================================
// 10. Books, paper and writing
// ===========================================================================

defineItem('book', { group: 'ingredients' });
defineItem('writable_book', { group: 'tools', stack: 1, display: 'Book and Quill' });
defineItem('written_book', { group: 'tools', stack: 16 });
defineItem('enchanted_book', { group: 'brewing', stack: 1, rarity: 'uncommon' });

// ===========================================================================
// 11. Throwables and simple projectiles
// ===========================================================================

defineItem('snowball', { group: 'combat', stack: 16, onUse: throwHandler('snowball', 1.5, 'throw') });
defineItem('egg', { group: 'ingredients', stack: 16, onUse: throwHandler('egg', 1.5, 'throw') });
defineItem('experience_bottle', { group: 'brewing', stack: 64, onUse: throwHandler('experience_bottle', 1.4, 'throw') });
defineItem('glass_bottle', { group: 'brewing', onUse: glassBottleUse });

// ===========================================================================
// 12. Vehicles
// ===========================================================================

for (const w of WOODS) {
  defineItem(`${w}_boat`, { group: 'transport', stack: 1, onUseOnBlock: vehicleUse('boat', w) });
  defineItem(`${w}_chest_boat`, { group: 'transport', stack: 1, onUseOnBlock: vehicleUse('chest_boat', w) });
}
defineItem('bamboo_raft', { group: 'transport', stack: 1, onUseOnBlock: vehicleUse('boat', 'bamboo') });
defineItem('bamboo_chest_raft', { group: 'transport', stack: 1, onUseOnBlock: vehicleUse('chest_boat', 'bamboo') });
for (const [item, type] of [['minecart', 'minecart'], ['chest_minecart', 'chest_minecart'], ['furnace_minecart', 'furnace_minecart'],
  ['tnt_minecart', 'tnt_minecart'], ['hopper_minecart', 'hopper_minecart']]) {
  defineItem(item, { group: 'transport', stack: 1, onUseOnBlock: vehicleUse(type, null) });
}

// ===========================================================================
// 13. Music discs, sherds, templates and banner patterns
// ===========================================================================

const MUSIC_DISCS = [
  ['13', 'C418 - 13'], ['cat', 'C418 - cat'], ['blocks', 'C418 - blocks'], ['chirp', 'C418 - chirp'],
  ['far', 'C418 - far'], ['mall', 'C418 - mall'], ['mellohi', 'C418 - mellohi'], ['stal', 'C418 - stal'],
  ['strad', 'C418 - strad'], ['ward', 'C418 - ward'], ['11', 'C418 - 11'], ['wait', 'C418 - wait'],
  ['otherside', 'Lena Raine - otherside'], ['5', 'Samuel Åberg - 5'], ['pigstep', 'Lena Raine - Pigstep'],
  ['relic', 'Aaron Cherof - Relic'],
];
for (const [id, desc] of MUSIC_DISCS) {
  defineItem(`music_disc_${id}`, {
    group: 'misc', stack: 1, rarity: id === 'pigstep' || id === 'otherside' || id === '5' ? 'rare' : 'uncommon',
    music: id, display: `Music Disc (${id})`, tags: [desc],
  });
}

for (const s of POTTERY_SHERDS) defineItem(`${s}_pottery_sherd`, { group: 'ingredients' });

const TRIM_PATTERNS = ['coast', 'dune', 'eye', 'host', 'raiser', 'rib', 'sentry', 'shaper', 'silence',
  'snout', 'spire', 'tide', 'vex', 'ward', 'wayfinder', 'wild'];
defineItem('netherite_upgrade_smithing_template', { group: 'ingredients', rarity: 'uncommon', display: 'Netherite Upgrade' });
for (const t of TRIM_PATTERNS) {
  defineItem(`${t}_armor_trim_smithing_template`, { group: 'ingredients', rarity: 'uncommon', display: `${prettyName(t)} Armor Trim` });
}

const BANNER_PATTERNS = ['flower', 'creeper', 'skull', 'mojang', 'globe', 'piglin', 'flow', 'guster'];
for (const p of BANNER_PATTERNS) {
  defineItem(`${p}_banner_pattern`, { group: 'misc', stack: 1, rarity: p === 'mojang' || p === 'globe' ? 'epic' : 'uncommon' });
}

// ===========================================================================
// 14. Potions
//
// One item per (form x potion type). `POTION_BY_ID` is the shared table the
// drink handler and brewing.js both read.
// ===========================================================================

const POTION_TYPES = [
  { id: 'water', label: 'Water Bottle', plain: true, color: 0x385dc6, effects: [] },
  { id: 'mundane', label: 'Mundane', color: 0x385dc6, effects: [] },
  { id: 'thick', label: 'Thick', color: 0x385dc6, effects: [] },
  { id: 'awkward', label: 'Awkward', color: 0x385dc6, effects: [] },
  { id: 'night_vision', label: 'Night Vision', color: 0x1f1fa1, effects: [['night_vision', 3600, 0]] },
  { id: 'long_night_vision', label: 'Night Vision', color: 0x1f1fa1, effects: [['night_vision', 9600, 0]] },
  { id: 'invisibility', label: 'Invisibility', color: 0x7f8392, effects: [['invisibility', 3600, 0]] },
  { id: 'long_invisibility', label: 'Invisibility', color: 0x7f8392, effects: [['invisibility', 9600, 0]] },
  { id: 'leaping', label: 'Leaping', color: 0x22ff4c, effects: [['jump_boost', 3600, 0]] },
  { id: 'long_leaping', label: 'Leaping', color: 0x22ff4c, effects: [['jump_boost', 9600, 0]] },
  { id: 'strong_leaping', label: 'Leaping', color: 0x22ff4c, effects: [['jump_boost', 1800, 1]] },
  { id: 'fire_resistance', label: 'Fire Resistance', color: 0xe49a3a, effects: [['fire_resistance', 3600, 0]] },
  { id: 'long_fire_resistance', label: 'Fire Resistance', color: 0xe49a3a, effects: [['fire_resistance', 9600, 0]] },
  { id: 'swiftness', label: 'Swiftness', color: 0x7cafc6, effects: [['speed', 3600, 0]] },
  { id: 'long_swiftness', label: 'Swiftness', color: 0x7cafc6, effects: [['speed', 9600, 0]] },
  { id: 'strong_swiftness', label: 'Swiftness', color: 0x7cafc6, effects: [['speed', 1800, 1]] },
  { id: 'slowness', label: 'Slowness', color: 0x5a6c81, effects: [['slowness', 1800, 0]] },
  { id: 'long_slowness', label: 'Slowness', color: 0x5a6c81, effects: [['slowness', 4800, 0]] },
  { id: 'strong_slowness', label: 'Slowness', color: 0x5a6c81, effects: [['slowness', 400, 3]] },
  { id: 'turtle_master', label: 'the Turtle Master', color: 0x9c9c9c, effects: [['slowness', 400, 3], ['resistance', 400, 2]] },
  { id: 'long_turtle_master', label: 'the Turtle Master', color: 0x9c9c9c, effects: [['slowness', 800, 3], ['resistance', 800, 2]] },
  { id: 'strong_turtle_master', label: 'the Turtle Master', color: 0x9c9c9c, effects: [['slowness', 400, 5], ['resistance', 400, 3]] },
  { id: 'water_breathing', label: 'Water Breathing', color: 0x2e5299, effects: [['water_breathing', 3600, 0]] },
  { id: 'long_water_breathing', label: 'Water Breathing', color: 0x2e5299, effects: [['water_breathing', 9600, 0]] },
  { id: 'healing', label: 'Healing', color: 0xf82423, effects: [['instant_health', 1, 0]] },
  { id: 'strong_healing', label: 'Healing', color: 0xf82423, effects: [['instant_health', 1, 1]] },
  { id: 'harming', label: 'Harming', color: 0x430a09, effects: [['instant_damage', 1, 0]] },
  { id: 'strong_harming', label: 'Harming', color: 0x430a09, effects: [['instant_damage', 1, 1]] },
  { id: 'poison', label: 'Poison', color: 0x4e9331, effects: [['poison', 900, 0]] },
  { id: 'long_poison', label: 'Poison', color: 0x4e9331, effects: [['poison', 1800, 0]] },
  { id: 'strong_poison', label: 'Poison', color: 0x4e9331, effects: [['poison', 432, 1]] },
  { id: 'regeneration', label: 'Regeneration', color: 0xcd5cab, effects: [['regeneration', 900, 0]] },
  { id: 'long_regeneration', label: 'Regeneration', color: 0xcd5cab, effects: [['regeneration', 1800, 0]] },
  { id: 'strong_regeneration', label: 'Regeneration', color: 0xcd5cab, effects: [['regeneration', 450, 1]] },
  { id: 'strength', label: 'Strength', color: 0x932423, effects: [['strength', 3600, 0]] },
  { id: 'long_strength', label: 'Strength', color: 0x932423, effects: [['strength', 9600, 0]] },
  { id: 'strong_strength', label: 'Strength', color: 0x932423, effects: [['strength', 1800, 1]] },
  { id: 'weakness', label: 'Weakness', color: 0x484d48, effects: [['weakness', 1800, 0]] },
  { id: 'long_weakness', label: 'Weakness', color: 0x484d48, effects: [['weakness', 4800, 0]] },
  { id: 'luck', label: 'Luck', color: 0x339900, effects: [['luck', 6000, 0]] },
  { id: 'slow_falling', label: 'Slow Falling', color: 0xf7f8e0, effects: [['slow_falling', 1800, 0]] },
  { id: 'long_slow_falling', label: 'Slow Falling', color: 0xf7f8e0, effects: [['slow_falling', 4800, 0]] },
];

/** id -> potion type record, shared with brewing.js. */
const POTION_BY_ID = {};
for (const t of POTION_TYPES) POTION_BY_ID[t.id] = t;

function potionDisplay(prefix, t) {
  if (t.plain) return prefix ? `${prefix} Water Bottle` : 'Water Bottle';
  if (t.effects.length === 0) return `${t.label} ${prefix || 'Potion'}`.trim();
  const noun = prefix || 'Potion';
  return `${noun} of ${t.label}`;
}

// Base items (what brewing.js hands out when it works with NBT-ish stacks).
defineItem('potion', { group: 'brewing', stack: 1, potion: 'water', color: 0x385dc6, useAction: 'drink', useDuration: 32, onUse: potionUse, onFinishUsing: potionFinish('water') });
defineItem('splash_potion', { group: 'brewing', stack: 1, potion: 'water', color: 0x385dc6, onUse: throwHandler('splash_potion', 1.1, 'throw') });
defineItem('lingering_potion', { group: 'brewing', stack: 1, potion: 'water', color: 0x385dc6, onUse: throwHandler('lingering_potion', 1.1, 'throw') });
defineItem('tipped_arrow', { group: 'combat', stack: 64, potion: 'water', color: 0x385dc6, projectile: 'tipped_arrow' });

for (const t of POTION_TYPES) {
  defineItem(`potion_${t.id}`, {
    group: 'brewing', stack: 1, texture: 'potion', color: t.color, potion: t.id,
    display: potionDisplay('', t), useAction: 'drink', useDuration: 32,
    onUse: potionUse, onFinishUsing: potionFinish(t.id),
  });
  defineItem(`splash_potion_${t.id}`, {
    group: 'brewing', stack: 1, texture: 'splash_potion', color: t.color, potion: t.id,
    display: potionDisplay('Splash Potion', t),
    onUse: throwHandler('splash_potion', 1.1, 'throw'),
  });
  defineItem(`lingering_potion_${t.id}`, {
    group: 'brewing', stack: 1, texture: 'lingering_potion', color: t.color, potion: t.id,
    display: potionDisplay('Lingering Potion', t),
    onUse: throwHandler('lingering_potion', 1.1, 'throw'),
  });
  if (t.effects.length) {
    defineItem(`tipped_arrow_${t.id}`, {
      group: 'combat', stack: 64, texture: 'tipped_arrow', color: t.color, potion: t.id,
      display: potionDisplay('Arrow', t), projectile: 'tipped_arrow',
    });
  }
}

// ===========================================================================
// 15. Spawn eggs - one per mob in CONTRACT section 22
// ===========================================================================

const SPAWN_EGG_MOBS = [
  // passive / neutral
  'pig', 'cow', 'mooshroom', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule',
  'skeleton_horse', 'zombie_horse', 'llama', 'trader_llama', 'wandering_trader', 'villager',
  'cat', 'ocelot', 'wolf', 'parrot', 'fox', 'bee', 'turtle', 'cod', 'salmon', 'tropical_fish',
  'pufferfish', 'squid', 'glow_squid', 'dolphin', 'axolotl', 'bat', 'frog', 'tadpole', 'allay',
  'sniffer', 'camel', 'goat', 'panda', 'polar_bear', 'strider', 'armadillo', 'snow_golem', 'iron_golem',
  // hostile
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'enderman', 'endermite', 'silverfish', 'slime', 'magma_cube',
  'blaze', 'ghast', 'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'witch',
  'guardian', 'elder_guardian', 'shulker', 'phantom', 'vex', 'evoker', 'vindicator', 'pillager',
  'ravager', 'illusioner', 'warden', 'breeze', 'creaking',
  // bosses
  'ender_dragon', 'wither',
];

const EGG_COLORS = {
  pig: [0xf0a5a2, 0xdb635f], cow: [0x443626, 0xa1a1a1], mooshroom: [0xa00f10, 0xb7b7b7],
  sheep: [0xe7e7e7, 0xffb5b5], chicken: [0xa1a1a1, 0xff0000], rabbit: [0x995f40, 0x734831],
  horse: [0xc09e7d, 0xeee500], donkey: [0x534539, 0x867566], mule: [0x1b0200, 0x51331d],
  skeleton_horse: [0x68684f, 0xe5e5d8], zombie_horse: [0x97c284, 0x4c7129],
  llama: [0xc09e7d, 0x995f40], trader_llama: [0xeaa430, 0x456296], wandering_trader: [0x456296, 0xe2c399],
  villager: [0x563c33, 0xbd8b72], cat: [0xefc88e, 0x957256], ocelot: [0xefde7d, 0x564434],
  wolf: [0xd7d3d3, 0xceaf96], parrot: [0x0da70b, 0xff0000], fox: [0xd5b69f, 0xf3743a],
  bee: [0xedc343, 0x43241b], turtle: [0xe7e7e7, 0x00afaf], cod: [0xc1c1c1, 0xe5c48b],
  salmon: [0x8d5c4d, 0xf1b2b2], tropical_fish: [0xef6e00, 0xbcffde], pufferfish: [0xf6b201, 0x37c3f2],
  squid: [0x223b4d, 0x708899], glow_squid: [0x095656, 0x92f1e3], dolphin: [0x223b4d, 0xf9f9f9],
  axolotl: [0xfbc1e3, 0xa62d74], bat: [0x4c3e30, 0x0f0f0f], frog: [0xd07d20, 0xeeda76],
  tadpole: [0x6d5f47, 0x1a1a1a], allay: [0x00daff, 0x00aeff], sniffer: [0x8b6c46, 0xd1c39b],
  camel: [0xfcc369, 0xcc9f5d], goat: [0xa5947c, 0x53452e], panda: [0xe7e7e7, 0x1b1b21],
  polar_bear: [0xf2f2f2, 0x959590], strider: [0x9c3436, 0x4d494d], armadillo: [0x703a26, 0xb1a495],
  snow_golem: [0xe7e7e7, 0xa1a1a1], iron_golem: [0xd9d9d9, 0xe7e7e7],
  zombie: [0x00afaf, 0x799c65], zombie_villager: [0x563c33, 0x799c65],
  husk: [0x7f7550, 0xe5c48b], drowned: [0x8ff1d7, 0x799c65], skeleton: [0xc1c1c1, 0x494949],
  stray: [0x6187a1, 0xdedede], bogged: [0x6b805e, 0xa8b2a1], wither_skeleton: [0x141414, 0x474d4d],
  creeper: [0x0da70b, 0x000000], spider: [0x342d27, 0xa80e0e], cave_spider: [0x0c424e, 0xa80e0e],
  enderman: [0x161616, 0x000000], endermite: [0x161616, 0x6d6d6d], silverfish: [0x6e6e6e, 0x303030],
  slime: [0x51a03e, 0x7ebf6e], magma_cube: [0x340000, 0xfcfc00], blaze: [0xf6b201, 0xfff87e],
  ghast: [0xf9f9f9, 0xbcbcbc], zombified_piglin: [0xea9393, 0x4c7129], piglin: [0x995f40, 0xf9f0a3],
  piglin_brute: [0x592a10, 0xf9f0a3], hoglin: [0xc66e55, 0x5f6464], zoglin: [0xc66e55, 0xe6e6e6],
  witch: [0x340000, 0x51a03e], guardian: [0x5a8272, 0xf17d31], elder_guardian: [0xceccba, 0x747693],
  shulker: [0x946495, 0x4d3852], phantom: [0x43518a, 0x88ff00], vex: [0x8891a2, 0x511a76],
  evoker: [0x959b9b, 0x1e1c1a], vindicator: [0x959b9b, 0x275e61], pillager: [0x532f36, 0x959b9b],
  ravager: [0x73716f, 0x5b5049], illusioner: [0x959b9b, 0x334781], warden: [0x0f4649, 0x39d6e0],
  breeze: [0xc0a8ff, 0xe9b8ff], creaking: [0x5f5f5f, 0xff5d00],
  ender_dragon: [0x1c1c1c, 0xcf51ff], wither: [0x141414, 0x4d4d4d],
};

for (const mob of SPAWN_EGG_MOBS) {
  const c = EGG_COLORS[mob] || [0x808080, 0x404040];
  defineItem(`${mob}_spawn_egg`, {
    group: 'misc', texture: 'spawn_egg', color: c[0], color2: c[1], mob,
    display: `${prettyName(mob)} Spawn Egg`,
    onUseOnBlock: spawnEggUse(mob),
    onUseOnEntity: spawnEggUseOnEntity(mob),
  });
}

// ===========================================================================
// 16. Auto-generated block items
//
// Every registered block that should be obtainable gets an item, unless an
// explicit item above already claimed the name or the block routes to a
// different item through its `itemName` field.
// ===========================================================================

const NO_ITEM_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'fire', 'soul_fire',
  'nether_portal', 'end_portal', 'end_gateway', 'piston_head', 'moving_piston',
  'bubble_column', 'frosted_ice', 'cave_vines', 'cave_vines_plant', 'chorus_plant',
  'tall_seagrass', 'wheat', 'powder_snow',
]);

const BLOCK_ITEM_RARITY = {
  beacon: 'rare', conduit: 'rare', dragon_egg: 'epic', budding_amethyst: 'uncommon',
  reinforced_deepslate: 'uncommon', spawner: 'uncommon', trial_spawner: 'uncommon',
  end_portal_frame: 'uncommon', bedrock: 'uncommon', barrier: 'epic', structure_void: 'epic',
  light: 'epic', ancient_debris: 'uncommon', netherite_block: 'uncommon', enchanting_table: 'uncommon',
  sculk_catalyst: 'uncommon', sculk_shrieker: 'uncommon', respawn_anchor: 'uncommon',
};

/** Vanilla stack limits for the handful of block items that are not 64. */
function blockItemStack(name) {
  if (name.endsWith('_bed')) return 1;
  if (name === 'shulker_box' || name.endsWith('_shulker_box')) return 1;
  if (name === 'cake') return 1;
  if (name.endsWith('_sign') || name.endsWith('_hanging_sign')) return 16;
  if (name.endsWith('_banner')) return 16;
  if (name === 'decorated_pot') return 64;
  return 64;
}

/** Picks the most representative texture name for a block's inventory icon. */
function blockIconTexture(def) {
  const t = def.tex;
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object') return t.side || t.all || t.north || t.top || t.front || def.name;
  return def.name;
}

defineItem('air', { block: 'air', group: 'misc', texture: 'air', display: 'Air' });

let _autoBlockItems = 0;
for (const def of BLOCKS) {
  if (!def) continue;
  const name = def.name;
  if (NO_ITEM_BLOCKS.has(name)) continue;
  // Blocks that hand out some other item (wall variants, crops, cauldrons...).
  if (def.itemName !== null && def.itemName !== name) continue;
  if (ITEMS[name]) { if (!ITEMS[name].block) ITEMS[name].block = name; continue; }
  defineItem(name, {
    display: def.display,
    block: name,
    texture: blockIconTexture(def),
    stack: blockItemStack(name),
    group: def.group || 'building',
    rarity: BLOCK_ITEM_RARITY[name] || 'common',
    fuel: def.burnTime || 0,
  });
  _autoBlockItems++;
}

// ===========================================================================
// 17. Creative tabs
// ===========================================================================

const TAB_DEFS = [
  { id: 'building_blocks', name: 'Building Blocks', icon: 'bricks' },
  { id: 'colored_blocks', name: 'Colored Blocks', icon: 'cyan_wool' },
  { id: 'natural', name: 'Natural Blocks', icon: 'grass_block' },
  { id: 'functional', name: 'Functional Blocks', icon: 'crafting_table' },
  { id: 'redstone', name: 'Redstone Blocks', icon: 'redstone' },
  { id: 'tools', name: 'Tools & Utilities', icon: 'iron_pickaxe' },
  { id: 'combat', name: 'Combat', icon: 'iron_sword' },
  { id: 'food_and_drink', name: 'Food & Drinks', icon: 'golden_apple' },
  { id: 'ingredients', name: 'Ingredients', icon: 'iron_ingot' },
  { id: 'spawn_eggs', name: 'Spawn Eggs', icon: 'pig_spawn_egg' },
  { id: 'brewing', name: 'Brewing', icon: 'potion_healing' },
  { id: 'misc', name: 'Miscellaneous', icon: 'ender_pearl' },
];

const COLORED_SUFFIXES = ['wool', 'carpet', 'concrete', 'concrete_powder', 'stained_glass',
  'stained_glass_pane', 'terracotta', 'glazed_terracotta', 'bed', 'banner', 'shulker_box', 'candle'];

function isColoredBlock(name) {
  for (const c of COLORS) {
    if (!name.startsWith(c + '_')) continue;
    const rest = name.slice(c.length + 1);
    if (COLORED_SUFFIXES.indexOf(rest) >= 0) return true;
  }
  return false;
}

// Blocks that are generated by the world rather than crafted.
const NATURAL_EXACT = new Set([
  'stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff', 'calcite', 'dripstone_block',
  'pointed_dripstone', 'gravel', 'clay', 'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block',
  'podzol', 'mycelium', 'mud', 'sand', 'red_sand', 'sandstone', 'red_sandstone', 'suspicious_sand',
  'suspicious_gravel', 'snow', 'snow_block', 'ice', 'packed_ice', 'blue_ice', 'obsidian',
  'crying_obsidian', 'netherrack', 'soul_sand', 'soul_soil', 'basalt', 'blackstone', 'magma_block',
  'glowstone', 'shroomlight', 'nether_wart_block', 'warped_wart_block', 'crimson_nylium',
  'warped_nylium', 'end_stone', 'bedrock', 'amethyst_block', 'budding_amethyst', 'small_amethyst_bud',
  'medium_amethyst_bud', 'large_amethyst_bud', 'amethyst_cluster', 'moss_block', 'moss_carpet',
  'sculk', 'sculk_vein', 'sculk_catalyst', 'sculk_shrieker', 'sculk_sensor', 'cobweb', 'sponge',
  'wet_sponge', 'turtle_egg', 'sniffer_egg', 'dragon_egg', 'melon', 'pumpkin', 'hay_block',
  'ochre_froglight', 'verdant_froglight', 'pearlescent_froglight', 'mangrove_roots',
  'muddy_mangrove_roots', 'cobblestone', 'mossy_cobblestone', 'infested_stone', 'infested_deepslate',
  'cobbled_deepslate', 'smooth_basalt', 'spawner', 'trial_spawner', 'water_bucket', 'lava_bucket',
  'powder_snow_bucket', 'bamboo', 'sugar_cane', 'cactus', 'lily_pad', 'vine', 'glow_lichen',
  'brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem', 'ancient_debris',
]);
const NATURAL_RE = /(_ore|_log|_wood|_leaves|_sapling|_roots|_fungus|_mushroom|_coral|_coral_block|_coral_fan|_tulip|_orchid|seagrass|kelp|_bud|_nylium|azalea|dripleaf|_propagule|_seeds)$/;
const NATURAL_START = ['infested_', 'stripped_', 'dead_'];

const FUNCTIONAL_EXACT = new Set([
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'ender_chest',
  'barrel', 'bookshelf', 'chiseled_bookshelf', 'lectern', 'enchanting_table', 'anvil', 'chipped_anvil',
  'damaged_anvil', 'brewing_stand', 'cauldron', 'beacon', 'conduit', 'respawn_anchor', 'lodestone',
  'loom', 'smithing_table', 'fletching_table', 'cartography_table', 'stonecutter', 'grindstone',
  'composter', 'bell', 'campfire', 'soul_campfire', 'scaffolding', 'ladder', 'torch', 'soul_torch',
  'lantern', 'soul_lantern', 'end_rod', 'flower_pot', 'decorated_pot', 'beehive', 'bee_nest',
  'jukebox', 'note_block', 'end_portal_frame', 'glass', 'tinted_glass', 'glass_pane', 'iron_bars',
  'chain', 'shulker_box', 'candle', 'barrier', 'structure_void', 'light', 'reinforced_deepslate',
  'slime_block', 'honey_block', 'sea_lantern', 'jack_o_lantern', 'carved_pumpkin', 'tnt',
  'cake', 'armor_stand', 'item_frame', 'glow_item_frame', 'painting', 'sea_pickle',
]);
const FUNCTIONAL_RE = /(_sign|_hanging_sign|_bed|_banner|_shulker_box|_candle|_door|_trapdoor|_fence_gate|_head|_skull)$/;

const TOOLS_EXTRA = new Set([
  'bucket', 'water_bucket', 'lava_bucket', 'milk_bucket', 'powder_snow_bucket', 'cod_bucket',
  'salmon_bucket', 'tropical_fish_bucket', 'pufferfish_bucket', 'axolotl_bucket', 'tadpole_bucket',
  'minecart', 'chest_minecart', 'furnace_minecart', 'tnt_minecart', 'hopper_minecart',
  'saddle', 'lead', 'name_tag', 'compass', 'recovery_compass', 'clock', 'map', 'filled_map',
  'spyglass', 'fishing_rod', 'flint_and_steel', 'shears', 'brush', 'goat_horn', 'writable_book',
  'written_book', 'carrot_on_a_stick', 'warped_fungus_on_a_stick', 'elytra', 'firework_rocket',
  'debug_stick', 'knowledge_book',
]);
const MISC_EXTRA = new Set(['end_crystal', 'firework_star', 'painting', 'item_frame', 'glow_item_frame',
  'armor_stand', 'totem_of_undying', 'enchanted_book', 'egg', 'snowball']);

const INGREDIENT_OVERRIDE = new Set(['string', 'wheat_seeds', 'melon_seeds', 'pumpkin_seeds',
  'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod', 'cocoa_beans', 'sugar', 'bone_meal']);

/** Decides which creative tab an item belongs in. */
function tabFor(def) {
  const n = def.name;
  if (n.endsWith('_spawn_egg')) return 'spawn_eggs';
  if (n === 'tipped_arrow' || n.startsWith('tipped_arrow_')) return 'combat';
  if (INGREDIENT_OVERRIDE.has(n)) return 'ingredients';
  if (n === 'nether_wart') return 'brewing';
  if (def.potion || n === 'glass_bottle' || n === 'experience_bottle' || n === 'ominous_bottle') return 'brewing';
  if (n.startsWith('music_disc_')) return 'misc';
  if (def.food) return 'food_and_drink';
  if (def.armor) return def.armor.slot === 'horse' ? 'combat' : 'combat';
  if (def.tool) {
    const k = def.tool.kind;
    return (k === 'sword' || k === 'trident') ? 'combat' : 'tools';
  }
  if (n === 'bow' || n === 'crossbow' || n === 'shield' || n === 'arrow' || n === 'spectral_arrow'
    || n === 'tipped_arrow' || n.startsWith('tipped_arrow_') || n === 'totem_of_undying'
    || n === 'fire_charge' || n === 'wind_charge') return 'combat';
  if (TOOLS_EXTRA.has(n)) return 'tools';
  if (def.block) {
    const b = BLOCK_BY_NAME.get(def.block);
    if (isColoredBlock(n)) return 'colored_blocks';
    if (b && (b.group === 'redstone' || b.group === 'transport')) return 'redstone';
    if (NATURAL_EXACT.has(n) || NATURAL_RE.test(n) || NATURAL_START.some((p) => n.startsWith(p))) return 'natural';
    if (FUNCTIONAL_EXACT.has(n) || FUNCTIONAL_RE.test(n) || (b && b.entityType)) return 'functional';
    if (b && b.group === 'food') return 'food_and_drink';
    return 'building_blocks';
  }
  if (MISC_EXTRA.has(n)) return 'misc';
  if (def.group === 'ingredients' || def.group === 'brewing') return def.group === 'brewing' ? 'brewing' : 'ingredients';
  if (def.group === 'transport') return 'tools';
  if (def.group === 'combat') return 'combat';
  if (def.group === 'tools') return 'tools';
  return 'misc';
}

{
  const byId = new Map();
  for (const t of TAB_DEFS) {
    const tab = { id: t.id, name: t.name, icon: t.icon, items: [] };
    byId.set(t.id, tab);
    CREATIVE_TABS.push(tab);
  }
  for (const name of ITEM_NAMES) {
    const def = ITEMS[name];
    if (!def || def.stub) continue;
    if (name === 'air') continue;
    const id = tabFor(def);
    def.tab = id;
    const tab = byId.get(id) || byId.get('misc');
    tab.items.push(name);
  }
  // Keep every tab's icon pointing at something that actually exists.
  for (const tab of CREATIVE_TABS) {
    if (!ITEMS[tab.icon] && tab.items.length) tab.icon = tab.items[0];
  }
}

/** Number of block items generated automatically; handy for tools/validate.mjs. */
export const AUTO_BLOCK_ITEM_COUNT = _autoBlockItems;
