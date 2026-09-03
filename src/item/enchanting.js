// ============================================================================
// enchanting.js - The enchantment registry, the enchanting table algorithm,
// the anvil, the grindstone and the combat maths that enchantments feed into.
//
// Storage convention: an enchanted item stack carries a plain object map of
// `name -> level` on BOTH `stack.enchants` and `stack.enchantments` (the same
// object, so either spelling works for readers). Reads also tolerate the array
// forms `[{name, level}]` and `[[name, level]]` so nothing breaks if another
// module hands us one.
//
// Nothing here touches the DOM, three.js or Game.* at module scope, so this
// file imports cleanly in Node for tools/validate.mjs.
// ============================================================================
import { clamp, prettyName, roman } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { getItem } from './items.js';
import { blockByName } from '../world/blocks.js';

// ---------------------------------------------------------------------------
// Rarity weights. Vanilla buckets: common 10, uncommon 5, rare 2, very rare 1.
// The weight drives both the enchanting-table lottery and the anvil price.
// ---------------------------------------------------------------------------
export const RARITY_WEIGHT = Object.freeze({ common: 10, uncommon: 5, rare: 2, very_rare: 1 });
/** Anvil level cost per enchantment level, keyed by rarity weight. */
const ANVIL_COST_BY_WEIGHT = { 10: 1, 5: 2, 2: 4, 1: 8 };
/** An anvil refuses to work at or above this many levels in survival. */
export const ANVIL_MAX_COST = 40;
/** Bookshelves that can influence one enchanting table. */
export const MAX_BOOKSHELVES = 15;

/** name -> enchantment definition. */
export const ENCHANTMENTS = {};
/** Registration-ordered list of every enchantment name. */
export const ENCHANTMENT_NAMES = [];
/** Registration-ordered list of every enchantment definition. */
export const ENCHANTMENT_LIST = [];

/**
 * Registers an enchantment.
 * `targets` are item category names (see `categoriesOf`), `min`/`max` are power
 * curves taking a level and returning the enchanting-table power band.
 */
export function defineEnchantment(name, def = {}) {
  if (ENCHANTMENTS[name]) return ENCHANTMENTS[name];
  const weight = def.weight || 10;
  const maxLevel = def.maxLevel || 1;
  const minPower = def.min || ((l) => 1 + (l - 1) * 10);
  const maxPower = def.max || ((l) => minPower(l) + 50);
  const targets = def.targets ? def.targets.slice() : ['breakable'];
  const e = {
    name,
    display: def.display || prettyName(name),
    maxLevel,
    minLevel: 1,
    weight,
    rarity: weight >= 10 ? 'common' : weight >= 5 ? 'uncommon' : weight >= 2 ? 'rare' : 'very_rare',
    // `applies` is the contract-facing name; `targets` is the same array.
    applies: targets,
    targets,
    // Primary targets are what the enchanting table offers; `applies` is the
    // wider set an anvil will accept (thorns on boots, sharpness on axes, ...).
    primary: def.primary ? def.primary.slice() : targets.slice(),
    conflicts: def.conflicts ? def.conflicts.slice() : [],
    group: def.group || null,          // mutual-exclusion group id
    treasure: !!def.treasure,
    curse: !!def.curse,
    discoverable: def.discoverable !== false,   // can the table roll it at all
    tradeable: def.tradeable !== false,         // villagers / loot chests
    minPower,
    maxPower,
    minCost: minPower,
    maxCost: maxPower,
    anvilCost: ANVIL_COST_BY_WEIGHT[weight] || 1,
    /** True when this enchantment may sit on that item (anvil rules). */
    appliesTo(itemName) { return canApply(name, itemName); },
  };
  ENCHANTMENTS[name] = e;
  ENCHANTMENT_NAMES.push(name);
  ENCHANTMENT_LIST.push(e);
  return e;
}

/** Look an enchantment up by name. Returns undefined when unknown. */
export function getEnchantment(name) { return ENCHANTMENTS[name]; }

// ---------------------------------------------------------------------------
// The registry. Power curves are vanilla `getMinCost` / `getMaxCost`.
// ---------------------------------------------------------------------------
const lin = (base, step) => (l) => base + (l - 1) * step;
const plus = (fn, span) => (l) => fn(l) + span;
const flat = (v) => () => v;

// --- Armour -----------------------------------------------------------------
{
  const pMin = lin(1, 11);
  defineEnchantment('protection', {
    maxLevel: 4, weight: 10, targets: ['armor'], group: 'protection',
    min: pMin, max: plus(pMin, 11),
  });
}
{
  const m = lin(10, 8);
  defineEnchantment('fire_protection', {
    maxLevel: 4, weight: 5, targets: ['armor'], group: 'protection', min: m, max: plus(m, 8),
  });
}
{
  const m = lin(5, 6);
  defineEnchantment('feather_falling', {
    maxLevel: 4, weight: 5, targets: ['armor_feet'], min: m, max: plus(m, 6),
  });
}
{
  const m = lin(5, 8);
  defineEnchantment('blast_protection', {
    maxLevel: 4, weight: 2, targets: ['armor'], group: 'protection', min: m, max: plus(m, 8),
  });
}
{
  const m = lin(3, 6);
  defineEnchantment('projectile_protection', {
    maxLevel: 4, weight: 5, targets: ['armor'], group: 'protection', min: m, max: plus(m, 6),
  });
}
defineEnchantment('respiration', {
  maxLevel: 3, weight: 2, targets: ['armor_head'],
  min: (l) => 10 * l, max: (l) => 10 * l + 30,
});
defineEnchantment('aqua_affinity', {
  maxLevel: 1, weight: 2, targets: ['armor_head'], min: flat(1), max: flat(41),
});
defineEnchantment('thorns', {
  maxLevel: 3, weight: 1, targets: ['armor'], primary: ['armor_chest'],
  min: lin(10, 20), max: (l) => 10 + (l - 1) * 20 + 50,
});
defineEnchantment('depth_strider', {
  maxLevel: 3, weight: 2, targets: ['armor_feet'], group: 'boots_walk',
  min: (l) => 10 * l, max: (l) => 10 * l + 15,
});
defineEnchantment('frost_walker', {
  maxLevel: 2, weight: 2, targets: ['armor_feet'], group: 'boots_walk', treasure: true,
  min: (l) => 10 * l, max: (l) => 10 * l + 15,
});
defineEnchantment('binding_curse', {
  display: 'Curse of Binding', maxLevel: 1, weight: 1, targets: ['wearable'],
  treasure: true, curse: true, min: flat(25), max: flat(50),
});
defineEnchantment('soul_speed', {
  maxLevel: 3, weight: 1, targets: ['armor_feet'], treasure: true, discoverable: false,
  min: (l) => 10 * l, max: (l) => 10 * l + 15,
});
defineEnchantment('swift_sneak', {
  maxLevel: 3, weight: 1, targets: ['armor_legs'], treasure: true, discoverable: false,
  min: (l) => 25 * l, max: (l) => 25 * l + 50,
});

// --- Swords and axes --------------------------------------------------------
{
  const m = lin(1, 11);
  defineEnchantment('sharpness', {
    maxLevel: 5, weight: 10, targets: ['sword', 'axe'], group: 'damage', min: m, max: plus(m, 20),
  });
}
{
  const m = lin(5, 8);
  defineEnchantment('smite', {
    maxLevel: 5, weight: 5, targets: ['sword', 'axe'], group: 'damage', min: m, max: plus(m, 20),
  });
  defineEnchantment('bane_of_arthropods', {
    display: 'Bane of Arthropods',
    maxLevel: 5, weight: 5, targets: ['sword', 'axe'], group: 'damage', min: m, max: plus(m, 20),
  });
}
{
  const m = lin(5, 20);
  defineEnchantment('knockback', { maxLevel: 2, weight: 5, targets: ['sword'], min: m, max: plus(m, 50) });
}
{
  const m = lin(10, 20);
  defineEnchantment('fire_aspect', { maxLevel: 2, weight: 2, targets: ['sword'], min: m, max: plus(m, 50) });
}
{
  const m = lin(15, 9);
  defineEnchantment('looting', { maxLevel: 3, weight: 2, targets: ['sword'], min: m, max: plus(m, 50) });
}
{
  const m = lin(5, 9);
  defineEnchantment('sweeping', {
    display: 'Sweeping Edge', maxLevel: 3, weight: 2, targets: ['sword'], min: m, max: plus(m, 15),
  });
}

// --- Tools ------------------------------------------------------------------
{
  const m = lin(1, 10);
  defineEnchantment('efficiency', {
    maxLevel: 5, weight: 10, targets: ['digger', 'shears'], min: m, max: plus(m, 50),
  });
}
defineEnchantment('silk_touch', {
  maxLevel: 1, weight: 1, targets: ['digger', 'shears'], group: 'drops',
  min: flat(15), max: flat(65),
});
{
  const m = lin(5, 8);
  defineEnchantment('unbreaking', { maxLevel: 3, weight: 5, targets: ['breakable'], min: m, max: plus(m, 50) });
}
{
  const m = lin(15, 9);
  defineEnchantment('fortune', {
    maxLevel: 3, weight: 2, targets: ['digger', 'shears'], group: 'drops', min: m, max: plus(m, 50),
  });
}

// --- Bows -------------------------------------------------------------------
{
  const m = lin(1, 10);
  defineEnchantment('power', { maxLevel: 5, weight: 10, targets: ['bow'], min: m, max: plus(m, 15) });
}
{
  const m = lin(12, 20);
  defineEnchantment('punch', { maxLevel: 2, weight: 2, targets: ['bow'], min: m, max: plus(m, 25) });
}
defineEnchantment('flame', { maxLevel: 1, weight: 2, targets: ['bow'], min: flat(20), max: flat(50) });
defineEnchantment('infinity', {
  maxLevel: 1, weight: 1, targets: ['bow'], group: 'arrow_supply', min: flat(20), max: flat(50),
});

// --- Fishing rods -----------------------------------------------------------
{
  const m = lin(15, 9);
  defineEnchantment('luck_of_the_sea', {
    display: 'Luck of the Sea', maxLevel: 3, weight: 2, targets: ['fishing_rod'], min: m, max: plus(m, 50),
  });
  defineEnchantment('lure', { maxLevel: 3, weight: 2, targets: ['fishing_rod'], min: m, max: plus(m, 50) });
}

// --- Tridents ---------------------------------------------------------------
defineEnchantment('loyalty', {
  maxLevel: 3, weight: 5, targets: ['trident'], group: 'trident_throw',
  min: (l) => 5 + l * 7, max: flat(50),
});
{
  const m = lin(1, 8);
  defineEnchantment('impaling', { maxLevel: 5, weight: 2, targets: ['trident'], min: m, max: plus(m, 20) });
}
defineEnchantment('riptide', {
  maxLevel: 3, weight: 2, targets: ['trident'], group: 'trident_throw',
  conflicts: ['channeling'], min: (l) => 10 + l * 7, max: flat(50),
});
defineEnchantment('channeling', {
  maxLevel: 1, weight: 1, targets: ['trident'], conflicts: ['riptide'],
  min: flat(25), max: flat(50),
});

// --- Crossbows --------------------------------------------------------------
defineEnchantment('multishot', {
  maxLevel: 1, weight: 2, targets: ['crossbow'], group: 'crossbow_shot', min: flat(20), max: flat(50),
});
defineEnchantment('quick_charge', {
  maxLevel: 3, weight: 5, targets: ['crossbow'], min: lin(12, 20), max: flat(50),
});
defineEnchantment('piercing', {
  maxLevel: 4, weight: 10, targets: ['crossbow'], group: 'crossbow_shot', min: lin(1, 10), max: flat(50),
});

// --- Universal --------------------------------------------------------------
defineEnchantment('mending', {
  maxLevel: 1, weight: 2, targets: ['breakable'], treasure: true, group: 'arrow_supply',
  min: flat(25), max: flat(75),
});
defineEnchantment('vanishing_curse', {
  display: 'Curse of Vanishing', maxLevel: 1, weight: 1, targets: ['vanishable'],
  treasure: true, curse: true, min: flat(25), max: flat(50),
});

// --- Mace (1.21) ------------------------------------------------------------
{
  const m = lin(5, 8);
  defineEnchantment('density', { maxLevel: 5, weight: 5, targets: ['mace'], group: 'damage', min: m, max: plus(m, 20) });
}
{
  const m = lin(15, 9);
  defineEnchantment('breach', { maxLevel: 4, weight: 2, targets: ['mace'], group: 'damage', min: m, max: plus(m, 20) });
  defineEnchantment('wind_burst', {
    maxLevel: 3, weight: 1, targets: ['mace'], treasure: true, min: m, max: plus(m, 20),
  });
}

// Expand the mutual-exclusion groups into explicit conflict lists so consumers
// can read `def.conflicts` directly without knowing about groups.
for (const a of ENCHANTMENT_LIST) {
  for (const b of ENCHANTMENT_LIST) {
    if (a === b) continue;
    if (a.group && a.group === b.group && !a.conflicts.includes(b.name)) a.conflicts.push(b.name);
  }
}
// Conflicts are symmetric even when only one side declared them.
for (const a of ENCHANTMENT_LIST) {
  for (const name of a.conflicts.slice()) {
    const b = ENCHANTMENTS[name];
    if (b && !b.conflicts.includes(a.name)) b.conflicts.push(a.name);
  }
}

/** True when two enchantments may coexist on one item. */
export function compatible(a, b) {
  if (a === b) return false;
  const da = ENCHANTMENTS[a], db = ENCHANTMENTS[b];
  if (!da || !db) return true;
  if (da.group && da.group === db.group) return false;
  return !da.conflicts.includes(b) && !db.conflicts.includes(a);
}

// ---------------------------------------------------------------------------
// Item categories - which enchantments an item can hold
// ---------------------------------------------------------------------------
const HEAD_ITEMS = new Set(['carved_pumpkin', 'player_head', 'zombie_head', 'creeper_head',
  'skeleton_skull', 'wither_skeleton_skull', 'dragon_head', 'piglin_head']);
const DIGGER_KINDS = new Set(['pickaxe', 'axe', 'shovel', 'hoe']);
const catCache = new Map();

/** Item name -> Set of enchantment category strings. Cached. */
function categoriesOf(itemName) {
  let cats = catCache.get(itemName);
  if (cats) return cats;
  cats = new Set(['all']);
  const def = getItem(itemName);
  const dur = def.durability | 0;
  if (dur > 0) { cats.add('breakable'); cats.add('vanishable'); }
  const armor = def.armor;
  if (armor && armor.index >= 0 && itemName !== 'elytra') {
    cats.add('armor');
    cats.add('armor_' + armor.slot);
    cats.add('wearable');
  }
  if (itemName === 'elytra') { cats.add('wearable'); cats.add('vanishable'); }
  if (HEAD_ITEMS.has(itemName) || itemName.endsWith('_head') || itemName.endsWith('_skull')) {
    cats.add('wearable'); cats.add('vanishable');
  }
  const tool = def.tool;
  const kind = tool ? tool.kind : null;
  if (kind === 'sword') { cats.add('sword'); cats.add('weapon'); }
  else if (kind === 'axe') { cats.add('axe'); cats.add('digger'); cats.add('weapon'); }
  else if (DIGGER_KINDS.has(kind)) cats.add('digger');
  else if (kind === 'shears') cats.add('shears');
  else if (kind === 'trident') { cats.add('trident'); cats.add('weapon'); }
  if (itemName === 'bow') cats.add('bow');
  if (itemName === 'crossbow') cats.add('crossbow');
  if (itemName === 'fishing_rod') cats.add('fishing_rod');
  if (itemName === 'trident') { cats.add('trident'); cats.add('weapon'); }
  if (itemName === 'shears') cats.add('shears');
  if (itemName === 'mace') { cats.add('mace'); cats.add('weapon'); cats.add('breakable'); cats.add('vanishable'); }
  if (itemName === 'book' || itemName === 'enchanted_book') cats.add('book');
  catCache.set(itemName, cats);
  return cats;
}

/** The item name behind a stack, a definition or a bare string. */
function itemNameOf(s) {
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.item || s.name || '';
}

/** True when `ench` may legally sit on `item` (a stack or an item name). */
export function canApply(ench, item) {
  const def = ENCHANTMENTS[typeof ench === 'string' ? ench : (ench && ench.name)];
  if (!def) return false;
  const name = itemNameOf(item);
  if (!name) return false;
  if (name === 'book' || name === 'enchanted_book') return true;
  const cats = categoriesOf(name);
  for (const t of def.targets) if (cats.has(t)) return true;
  return false;
}

/** True when the enchanting table itself may offer `ench` for `item`. */
export function canApplyAtTable(ench, item) {
  const def = ENCHANTMENTS[typeof ench === 'string' ? ench : (ench && ench.name)];
  if (!def) return false;
  const name = itemNameOf(item);
  if (name === 'book' || name === 'enchanted_book') return true;
  const cats = categoriesOf(name);
  for (const t of def.primary) if (cats.has(t)) return true;
  return false;
}

/** Every enchantment that could ever go on this item. -> definitions */
export function applicableEnchantments(item, allowTreasure = true) {
  const out = [];
  for (const e of ENCHANTMENT_LIST) {
    if (!allowTreasure && e.treasure) continue;
    if (canApply(e.name, item)) out.push(e);
  }
  return out;
}

// Vanilla enchantment values the item registry does not carry: books behave
// like value 1, the fishing rod is 1, and the mace (1.21) is 15.
const ENCHANTABILITY_OVERRIDE = { book: 1, enchanted_book: 1, fishing_rod: 1, mace: 15 };

/** Vanilla "enchantment value": how generous the table is with this item. */
export function enchantabilityOf(item) {
  const name = itemNameOf(item);
  if (!name) return 0;
  const over = ENCHANTABILITY_OVERRIDE[name];
  if (over !== undefined) return over;
  return getItem(name).enchantability | 0;
}

// ---------------------------------------------------------------------------
// Reading and writing enchantments on stacks
// ---------------------------------------------------------------------------

/** Normalises whatever shape a stack stores into a fresh `{name: level}` map. */
function readEnchants(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  const src = s.enchants || s.enchantments;
  if (!src) return out;
  if (Array.isArray(src)) {
    for (const e of src) {
      if (!e) continue;
      if (Array.isArray(e)) { if (e[0]) out[e[0]] = Math.max(1, (e[1] | 0) || 1); }
      else if (typeof e === 'string') out[e] = 1;
      else if (e.name) out[e.name] = Math.max(1, (e.level | 0) || 1);
    }
  } else if (typeof src === 'object') {
    for (const k of Object.keys(src)) { const v = src[k] | 0; if (v > 0) out[k] = v; }
  }
  return out;
}

/** Writes a `{name: level}` map onto a stack under both field spellings. */
function writeEnchants(s, map) {
  if (!s) return s;
  const keys = Object.keys(map || {}).filter((k) => (map[k] | 0) > 0);
  if (!keys.length) { delete s.enchants; delete s.enchantments; return s; }
  const clean = {};
  for (const k of keys) clean[k] = map[k] | 0;
  s.enchants = clean;
  s.enchantments = clean;
  return s;
}

/** Shallow stack copy with an independent enchantment map. */
function cloneStack(s) {
  const c = Object.assign({}, s);
  c.count = Math.max(1, s.count | 0);
  c.damage = Math.max(0, s.damage | 0);
  const m = readEnchants(s);
  if (Object.keys(m).length) writeEnchants(c, m);
  else { delete c.enchants; delete c.enchantments; }
  return c;
}

const isStack = (s) => !!(s && typeof s === 'object' && s.item && (s.count | 0) > 0);

/**
 * Level of one enchantment on a stack, 0 when absent.
 * Cheap enough for the combat hot path (no allocation on the common paths).
 */
export function getEnchant(stack, name) {
  if (!stack || !name || typeof stack !== 'object') return 0;
  const src = stack.enchants || stack.enchantments;
  if (!src) return 0;
  if (!Array.isArray(src)) return Math.max(0, src[name] | 0);
  for (const e of src) {
    if (!e) continue;
    if (Array.isArray(e)) { if (e[0] === name) return Math.max(1, (e[1] | 0) || 1); }
    else if (typeof e === 'string') { if (e === name) return 1; }
    else if (e.name === name) return Math.max(1, (e.level | 0) || 1);
  }
  return 0;
}

/** True when the stack carries this enchantment at all. */
export function hasEnchant(stack, name) { return getEnchant(stack, name) > 0; }

/** Every enchantment on a stack as `[{name, level}]`, registry order. */
export function listEnchantments(stack) {
  const map = readEnchants(stack);
  const out = [];
  for (const e of ENCHANTMENT_LIST) if (map[e.name]) out.push({ name: e.name, level: map[e.name] });
  // Unknown names still show up, after the known ones.
  for (const k of Object.keys(map)) if (!ENCHANTMENTS[k]) out.push({ name: k, level: map[k] });
  return out;
}

/** True when a stack carries any enchantment (curses included). */
export function isEnchanted(stack) {
  const src = stack && (stack.enchants || stack.enchantments);
  if (!src) return false;
  return Array.isArray(src) ? src.length > 0 : Object.keys(src).length > 0;
}

/** Tooltip lines like "Sharpness III" / "Curse of Binding". */
export function enchantmentTooltip(stack) {
  return listEnchantments(stack).map((e) => {
    const def = ENCHANTMENTS[e.name];
    const label = def ? def.display : prettyName(e.name);
    const lvl = def && def.maxLevel === 1 && e.level === 1 ? '' : ' ' + roman(e.level);
    return { text: label + lvl, color: def && def.curse ? '#fc5454' : '#a8a8ff' };
  });
}

/**
 * Puts an enchantment on a stack (mutating it) and returns the stack.
 * `ench` may be a name, a definition, or `{name, level}`. Books are promoted to
 * enchanted books. Levels clamp to the enchantment maximum unless `force`.
 */
export function applyEnchant(stack, ench, level, force = false) {
  if (!stack || typeof stack !== 'object' || !stack.item) return null;
  let name = ench, lv = level;
  if (ench && typeof ench === 'object') {
    name = ench.name;
    if (lv === undefined || lv === null) lv = ench.level;
  }
  const def = ENCHANTMENTS[name];
  if (!def) return stack;
  lv = Math.round(Number(lv));
  if (!Number.isFinite(lv) || lv <= 0) lv = 1;
  lv = force ? clamp(lv, 1, 255) : clamp(lv, 1, def.maxLevel);
  if (stack.item === 'book') stack.item = 'enchanted_book';
  const map = readEnchants(stack);
  if ((map[name] | 0) >= lv && !force) { writeEnchants(stack, map); return stack; }
  map[name] = lv;
  writeEnchants(stack, map);
  return stack;
}

/** Removes one enchantment (or all of them when `name` is omitted). */
export function removeEnchant(stack, name = null) {
  if (!stack) return stack;
  if (!name) { delete stack.enchants; delete stack.enchantments; return stack; }
  const map = readEnchants(stack);
  delete map[name];
  return writeEnchants(stack, map);
}

// ---------------------------------------------------------------------------
// Random-number plumbing. Callers may hand us an RNG, a bare function, a seed
// or nothing at all.
// ---------------------------------------------------------------------------
function wrapRng(rng, seed) {
  if (rng && typeof rng.next === 'function' && typeof rng.int === 'function') return rng;
  if (typeof rng === 'function') {
    return {
      next: rng,
      int: (n) => Math.floor(rng() * n),
      range: (a, b) => a + Math.floor(rng() * (b - a + 1)),
      chance: (p) => rng() < p,
    };
  }
  if (typeof rng === 'number') return new RNG(rng >>> 0);
  if (seed !== undefined && seed !== null) return new RNG(seed);
  return new RNG(((Math.random() * 0xffffffff) >>> 0) || 1);
}

/** Weighted lottery over `[{name, level, weight}]`. */
function pickWeighted(pool, r) {
  let total = 0;
  for (const e of pool) total += e.weight;
  if (total <= 0) return pool[0];
  let x = r.next() * total;
  for (const e of pool) { x -= e.weight; if (x <= 0) return e; }
  return pool[pool.length - 1];
}

// ---------------------------------------------------------------------------
// The enchanting table
// ---------------------------------------------------------------------------

/**
 * Every (enchantment, level) pair whose power band contains `power`.
 * This is vanilla's `getAvailableEnchantmentResults`.
 */
export function availableEnchantments(power, stack, allowTreasure = false) {
  const out = [];
  const name = itemNameOf(stack);
  const isBook = name === 'book' || name === 'enchanted_book';
  for (const e of ENCHANTMENT_LIST) {
    if (e.treasure && !allowTreasure) continue;
    if (!e.discoverable) continue;
    if (!isBook && !canApplyAtTable(e.name, name)) continue;
    for (let l = e.maxLevel; l >= 1; l--) {
      if (power >= e.minPower(l) && power <= e.maxPower(l)) {
        out.push({ name: e.name, level: l, weight: e.weight });
        break;
      }
    }
  }
  return out;
}

/**
 * Rolls the enchantments an item receives at enchanting power `level`.
 * This is vanilla's `EnchantmentHelper.selectEnchantment`: the item's
 * enchantability widens the roll, a +/-15% fuzz is applied, then extra
 * enchantments are drawn while `rng(50) <= level`, halving the level each time.
 *
 * Called with `level` omitted it degrades into "list what is already on this
 * stack", which is the other reading of the name.
 */
export function enchantmentsFor(stack, level, rng = null, allowTreasure = false) {
  if (level === undefined || level === null) return listEnchantments(stack);
  const out = [];
  const ev = enchantabilityOf(stack);
  if (ev <= 0) return out;
  const r = wrapRng(rng);
  const quarter = Math.floor(ev / 4) + 1;
  let lvl = (level | 0) + 1 + r.int(quarter) + r.int(quarter);
  const fuzz = (r.next() + r.next() - 1) * 0.15;
  lvl = Math.max(1, Math.round(lvl + lvl * fuzz));
  let pool = availableEnchantments(lvl, stack, allowTreasure);
  if (!pool.length) return out;
  out.push(pickWeighted(pool, r));
  for (;;) {
    if (r.int(50) > lvl) break;
    const last = out[out.length - 1];
    pool = pool.filter((e) => e.name !== last.name && compatible(e.name, last.name));
    if (!pool.length) break;
    out.push(pickWeighted(pool, r));
    lvl = Math.floor(lvl / 2);
  }
  return out.map((e) => ({ name: e.name, level: e.level }));
}

/**
 * The three offers an enchanting table shows.
 * `bookshelves` is 0..15, `seed` is the player's enchantment seed (offers are
 * stable for a given seed, exactly like vanilla). Returns three entries:
 *   { slot, level, xpCost, cost, lapis, enchantments: [{name, level}], hint }
 * where `level` is the XP level requirement and `cost`/`lapis` is the lapis
 * price (slot + 1). A slot with `level === 0` is not offered.
 */
export function tableOffers(stack, bookshelves = 0, rng = null, seed = undefined) {
  const power = clamp(bookshelves | 0, 0, MAX_BOOKSHELVES);
  const ev = enchantabilityOf(stack);
  const hasSeed = seed !== undefined && seed !== null;
  const r = hasSeed ? new RNG(seed) : wrapRng(rng);
  const itemName = itemNameOf(stack);
  const offers = [];
  for (let slot = 0; slot < 3; slot++) {
    let lvl = 0;
    if (ev > 0 && itemName) {
      const j = r.int(8) + 1 + (power >> 1) + r.int(power + 1);
      if (slot === 0) lvl = Math.max(Math.floor(j / 3), 1);
      else if (slot === 1) lvl = Math.floor((j * 2) / 3) + 1;
      else lvl = Math.max(j, power * 2);
      if (lvl < slot + 1) lvl = 0;
    }
    offers.push({
      slot, level: lvl, xpCost: lvl, cost: slot + 1, lapis: slot + 1,
      enchantments: [], hint: '', hintName: null, hintLevel: 0, available: lvl > 0,
    });
  }
  for (let slot = 0; slot < 3; slot++) {
    const o = offers[slot];
    if (o.level <= 0) continue;
    // Vanilla re-seeds per slot so the clue is stable while the player browses.
    const sr = hasSeed ? new RNG(hashSeed(seed, slot)) : r;
    const list = enchantmentsFor(stack, o.level, sr, false);
    if (itemName === 'book' && list.length > 1) list.splice(sr.int(list.length), 1);
    o.enchantments = list;
    if (!list.length) { o.available = false; continue; }
    const clue = list[sr.int(list.length)];
    const def = ENCHANTMENTS[clue.name];
    o.hintName = clue.name;
    o.hintLevel = clue.level;
    o.hint = (def ? def.display : prettyName(clue.name)) + (clue.level > 1 || (def && def.maxLevel > 1) ? ' ' + roman(clue.level) : '');
  }
  return offers;
}

function hashSeed(seed, slot) {
  const s = typeof seed === 'string' ? seed + ':' + slot : ((seed | 0) + slot + 1) >>> 0;
  return s || 1;
}

/**
 * Applies a `tableOffers` entry to a stack (mutating it) and returns it.
 * A plain book becomes an enchanted book, as in vanilla.
 */
export function applyOffer(stack, offer) {
  if (!stack || !offer || !offer.enchantments || !offer.enchantments.length) return stack;
  for (const e of offer.enchantments) applyEnchant(stack, e.name, e.level);
  return stack;
}

/**
 * Rolls and applies enchantments at a given power - the loot-table entry point
 * ("enchant with levels"). Returns the same stack for chaining.
 */
export function enchantWithLevels(stack, level, rng = null, allowTreasure = false) {
  if (!stack) return stack;
  const list = enchantmentsFor(stack, level, rng, allowTreasure);
  for (const e of list) applyEnchant(stack, e.name, e.level);
  return stack;
}

/**
 * Picks one random enchantment for an enchanted book, weighted like the table.
 * Used by loot tables and villager trades.
 */
export function randomBookEnchant(rng = null, allowTreasure = true) {
  const r = wrapRng(rng);
  const pool = ENCHANTMENT_LIST.filter((e) => (allowTreasure || !e.treasure) && e.tradeable);
  if (!pool.length) return null;
  let total = 0;
  for (const e of pool) total += e.weight;
  let x = r.next() * total;
  let chosen = pool[pool.length - 1];
  for (const e of pool) { x -= e.weight; if (x <= 0) { chosen = e; break; } }
  return { name: chosen.name, level: r.range(1, chosen.maxLevel) };
}

/**
 * Counts the bookshelves that empower an enchanting table at (x, y, z).
 * A shelf counts when it sits in the 5x5 ring two blocks out, at the table's
 * level or one above, with a clear block between it and the table.
 */
export function countBookshelves(world, x, y, z) {
  if (!world) return 0;
  const shelf = blockByName('bookshelf');
  if (!shelf) return 0;
  let n = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      // The gap next to the table must be free for the shelf to be seen.
      if (!isTransparentForShelf(world, x + dx, y, z + dz)) continue;
      if (!isTransparentForShelf(world, x + dx, y + 1, z + dz)) continue;
      for (let dy = 0; dy <= 1; dy++) {
        if (world.getBlock(x + dx * 2, y + dy, z + dz * 2) === shelf.id) n++;
        if (dx !== 0 && dz !== 0) {
          if (world.getBlock(x + dx * 2, y + dy, z + dz) === shelf.id) n++;
          if (world.getBlock(x + dx, y + dy, z + dz * 2) === shelf.id) n++;
        }
      }
      if (n >= MAX_BOOKSHELVES) return MAX_BOOKSHELVES;
    }
  }
  return Math.min(n, MAX_BOOKSHELVES);
}

function isTransparentForShelf(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  if (id === 0) return true;
  return !world.isOpaque(x, y, z);
}

// ---------------------------------------------------------------------------
// The anvil
// ---------------------------------------------------------------------------
const TAG_MATCHERS = {
  planks: (n) => n.endsWith('_planks'),
  logs: (n) => n.endsWith('_log') || n.endsWith('_stem'),
  wool: (n) => n.endsWith('_wool'),
  stone_tool_materials: (n) => n === 'cobblestone' || n === 'blackstone' || n === 'cobbled_deepslate',
};

function matchIngredient(spec, name) {
  if (!spec || !name) return false;
  if (spec.charAt(0) === '#') {
    const tag = spec.slice(1);
    const m = TAG_MATCHERS[tag];
    if (m) return m(name);
    return name === tag || name.endsWith('_' + tag) ||
      (tag.endsWith('s') && name.endsWith('_' + tag.slice(0, -1)));
  }
  return spec === name;
}

/** True when `material` repairs `itemName` on an anvil. */
export function isRepairMaterial(itemName, material) {
  const rw = getItem(itemName).repairWith;
  if (!rw) return false;
  if (Array.isArray(rw)) return rw.some((r) => matchIngredient(r, material));
  return matchIngredient(rw, material);
}

const maxDamageOf = (itemName) => getItem(itemName).durability | 0;
const anvilCostPerLevel = (def, fromBook) => {
  const c = def.anvilCost || 1;
  return fromBook ? Math.max(1, Math.floor(c / 2)) : c;
};

/** Vanilla's prior-work penalty: every anvil use doubles the next one. */
export const increasedRepairCost = (c) => (c | 0) * 2 + 1;

/**
 * Works out what an anvil produces from `left` + `right`, optionally renamed.
 * Handles: repairing with a material, merging two damaged items, applying an
 * enchanted book, merging enchantments (equal levels combine upward, different
 * levels take the highest), incompatible-enchantment penalties, renaming, the
 * prior-work penalty and the 40-level "Too Expensive!" wall.
 *
 * Returns `null` when the two inputs cannot combine at all. When they combine
 * but cost 40+ levels the result carries `stack: null` and `tooExpensive: true`
 * so the UI can say so.
 */
export function anvilResult(left, right, name = null) {
  if (!isStack(left)) return null;
  const leftDef = getItem(left.item);
  const maxDmg = maxDamageOf(left.item);
  const out = cloneStack(left);
  const map = readEnchants(left);
  let cost = 0;                                        // levels earned this use
  let materialCost = 0;                                // units of repair material
  const prior = (left.repairCost | 0) + (isStack(right) ? (right.repairCost | 0) : 0);

  if (isStack(right)) {
    const rightMap = readEnchants(right);
    const rightIsBook = right.item === 'enchanted_book' && Object.keys(rightMap).length > 0;

    if (maxDmg > 0 && (out.damage | 0) > 0 && isRepairMaterial(left.item, right.item)) {
      // --- repair with raw material: each unit mends a quarter of the bar ---
      let chunk = Math.min(out.damage | 0, Math.floor(maxDmg / 4));
      if (chunk <= 0) return null;
      let used = 0;
      while (chunk > 0 && used < (right.count | 0)) {
        out.damage = (out.damage | 0) - chunk;
        cost += 1;
        used++;
        chunk = Math.min(out.damage | 0, Math.floor(maxDmg / 4));
      }
      materialCost = used;
    } else {
      if (!rightIsBook && (left.item !== right.item || maxDmg <= 0)) return null;

      if (maxDmg > 0 && !rightIsBook) {
        // --- merge two of the same item: durability adds, plus a 12% bonus ---
        const leftLeft = maxDmg - (left.damage | 0);
        const rightLeft = maxDmg - (right.damage | 0);
        const gained = rightLeft + Math.floor((maxDmg * 12) / 100);
        let newDamage = maxDmg - (leftLeft + gained);
        if (newDamage < 0) newDamage = 0;
        if (newDamage < (out.damage | 0)) { out.damage = newDamage; cost += 2; }
      }

      let anyApplied = false, anyRejected = false;
      for (const ename of Object.keys(rightMap)) {
        const def = ENCHANTMENTS[ename];
        if (!def) continue;
        const cur = map[ename] | 0;
        const incoming = rightMap[ename] | 0;
        let lv = cur === incoming ? incoming + 1 : Math.max(incoming, cur);
        let ok = canApply(ename, left.item) || left.item === 'enchanted_book';
        for (const other of Object.keys(map)) {
          if (other !== ename && !compatible(ename, other)) { ok = false; cost += 1; }
        }
        if (!ok) { anyRejected = true; continue; }
        anyApplied = true;
        if (lv > def.maxLevel) lv = def.maxLevel;
        map[ename] = lv;
        cost += anvilCostPerLevel(def, rightIsBook) * lv;
        if ((left.count | 0) > 1) cost = ANVIL_MAX_COST;
      }
      if (anyRejected && !anyApplied) return null;
    }
  }

  // --- renaming ---
  const currentName = left.customName || left.displayName || null;
  const defaultName = leftDef.display;
  let renameCost = 0;
  let renamed = false;
  if (name === null || name === undefined || String(name).trim() === '') {
    if (currentName) {
      renameCost = 1; cost += 1; renamed = true;
      delete out.customName; delete out.displayName;
    }
  } else if (String(name) !== (currentName || defaultName)) {
    renameCost = 1; cost += 1; renamed = true;
    out.customName = String(name);
    out.displayName = String(name);
  }

  if (cost <= 0) return null;   // nothing about the item actually changed

  let total = prior + cost;
  // A pure rename is never allowed to hit the wall.
  if (renameCost === cost && renameCost > 0 && total >= ANVIL_MAX_COST) total = ANVIL_MAX_COST - 1;

  writeEnchants(out, map);

  let newRepair = out.repairCost | 0;
  if (isStack(right) && (right.repairCost | 0) > newRepair) newRepair = right.repairCost | 0;
  if (renameCost !== cost || renameCost === 0) newRepair = increasedRepairCost(newRepair);
  out.repairCost = newRepair;

  if (total >= ANVIL_MAX_COST) {
    return { stack: null, cost: total, levelsRequired: total, materialCost, renamed, tooExpensive: true };
  }
  return { stack: out, cost: total, levelsRequired: total, materialCost, renamed, tooExpensive: false };
}

// ---------------------------------------------------------------------------
// The grindstone
// ---------------------------------------------------------------------------

/** Strips every non-curse enchantment, resets the prior-work penalty. */
function stripEnchants(s, damage, count) {
  const out = Object.assign({}, s);
  out.count = Math.max(1, count | 0);
  out.damage = Math.max(0, damage | 0);
  const map = readEnchants(s);
  const curses = {};
  for (const k of Object.keys(map)) if (ENCHANTMENTS[k] && ENCHANTMENTS[k].curse) curses[k] = map[k];
  const curseCount = Object.keys(curses).length;
  writeEnchants(out, curses);
  out.repairCost = 0;
  if (out.item === 'enchanted_book' && curseCount === 0) {
    out.item = 'book';
    out.damage = 0;
  }
  for (let i = 0; i < curseCount; i++) out.repairCost = increasedRepairCost(out.repairCost);
  return out;
}

/** XP a single stack is worth when ground down (sum of enchantment min costs). */
function xpFromItem(s) {
  if (!isStack(s)) return 0;
  let total = 0;
  const map = readEnchants(s);
  for (const k of Object.keys(map)) {
    const def = ENCHANTMENTS[k];
    if (!def || def.curse) continue;
    total += def.minPower(clamp(map[k] | 0, 1, def.maxLevel));
  }
  return total;
}

/**
 * The grindstone: disenchants one item, or merges two of the same item into a
 * repaired, disenchanted one (durability adds plus a 5% bonus). Curses stay.
 * Returns `{ stack, xp, xpMin, xpMax }` or `null` when there is nothing to do.
 * Pass an `rng` for the vanilla random XP roll; without one the XP is the
 * deterministic minimum so a UI preview does not flicker.
 */
export function grindstoneResult(a, b, rng = null) {
  const A = isStack(a) ? a : null;
  const B = isStack(b) ? b : null;
  if (!A && !B) return null;

  let out = null;
  if (A && B) {
    if (A.item !== B.item) return null;
    const maxDmg = maxDamageOf(A.item);
    if (maxDmg <= 0) return null;
    if ((A.count | 0) > 1 || (B.count | 0) > 1) return null;
    const left = maxDmg - (A.damage | 0);
    const right = maxDmg - (B.damage | 0);
    const restored = left + right + Math.floor((maxDmg * 5) / 100);
    out = stripEnchants(A, Math.max(maxDmg - restored, 0), 1);
  } else {
    const src = A || B;
    if (!isEnchanted(src)) return null;
    out = stripEnchants(src, src.damage | 0, src.count | 0);
  }

  const total = xpFromItem(A) + xpFromItem(B);
  let xp = 0, xpMin = 0, xpMax = 0;
  if (total > 0) {
    const half = Math.ceil(total / 2);
    xpMin = half;
    xpMax = half * 2 - 1;
    xp = rng ? half + wrapRng(rng).int(half) : half;
  }
  return { stack: out, xp, xpMin, xpMax };
}

// ---------------------------------------------------------------------------
// Combat maths
// ---------------------------------------------------------------------------
const UNDEAD = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray',
  'bogged', 'wither_skeleton', 'skeleton_horse', 'zombie_horse', 'zombified_piglin', 'zoglin',
  'phantom', 'wither', 'giant']);
const ARTHROPODS = new Set(['spider', 'cave_spider', 'silverfish', 'endermite', 'bee']);
const AQUATIC = new Set(['guardian', 'elder_guardian', 'squid', 'glow_squid', 'cod', 'salmon',
  'tropical_fish', 'pufferfish', 'turtle', 'dolphin', 'drowned', 'axolotl', 'tadpole']);

/** Classifies an entity (or a mob name) for smite / bane / impaling. */
export function mobTypeOf(target) {
  const name = typeof target === 'string' ? target : (target && (target.type || target.name)) || '';
  const def = target && typeof target === 'object' ? (target.def || target.definition || target) : null;
  return {
    undead: !!(def && def.undead) || UNDEAD.has(name),
    arthropod: !!(def && def.arthropod) || ARTHROPODS.has(name),
    aquatic: !!(def && def.waterMob) || AQUATIC.has(name) ||
      !!(target && typeof target === 'object' && (target.inWater || target.submerged)),
  };
}

/**
 * Extra melee damage the held stack contributes against this target:
 * sharpness (+0.5 per level, +0.5 flat), smite and bane of arthropods
 * (+2.5 per level against undead / arthropods) and impaling (+2.5 per level
 * against anything aquatic or standing in water).
 */
export function bonusDamage(stack, target) {
  if (!stack) return 0;
  let bonus = 0;
  const sharp = getEnchant(stack, 'sharpness');
  if (sharp > 0) bonus += 0.5 * sharp + 0.5;
  const smite = getEnchant(stack, 'smite');
  const bane = getEnchant(stack, 'bane_of_arthropods');
  const impale = getEnchant(stack, 'impaling');
  if (smite > 0 || bane > 0 || impale > 0) {
    const t = mobTypeOf(target);
    if (smite > 0 && t.undead) bonus += 2.5 * smite;
    if (bane > 0 && t.arthropod) bonus += 2.5 * bane;
    if (impale > 0 && t.aquatic) bonus += 2.5 * impale;
  }
  return bonus;
}

/** Mace density bonus: +0.5 damage per level per block of the attacker's fall. */
export function maceDamageBonus(stack, fallDistance) {
  const d = getEnchant(stack, 'density');
  if (d <= 0 || !(fallDistance > 0)) return 0;
  return 0.5 * d * fallDistance;
}

const BYPASS_TYPES = new Set(['void', 'out_of_world', 'starve', 'kill', 'generic_kill', 'wither_effect']);
const FIRE_TYPES = new Set(['fire', 'in_fire', 'on_fire', 'lava', 'hot_floor', 'burn', 'campfire', 'magma']);
const BLAST_TYPES = new Set(['explosion', 'creeper', 'tnt', 'bed', 'firework', 'blast']);
const PROJECTILE_TYPES = new Set(['arrow', 'projectile', 'thrown', 'trident', 'fireball',
  'small_fireball', 'dragon_fireball', 'wither_skull', 'shulker_bullet', 'llama_spit', 'snowball', 'egg']);

function sourceFlags(source) {
  if (!source) return { fall: false, fire: false, blast: false, projectile: false, bypass: false };
  const type = source.type || '';
  return {
    fall: type === 'fall' || type === 'fly_into_wall' || !!source.fall,
    fire: !!source.fire || FIRE_TYPES.has(type),
    blast: !!source.explosion || BLAST_TYPES.has(type) || type.indexOf('explosion') >= 0,
    projectile: !!source.projectile || PROJECTILE_TYPES.has(type),
    bypass: !!source.bypassMagic || BYPASS_TYPES.has(type),
  };
}

function armorList(armorStacks) {
  if (!armorStacks) return null;
  if (Array.isArray(armorStacks)) return armorStacks;
  if (Array.isArray(armorStacks.slots)) return armorStacks.slots;
  if (armorStacks.item) return [armorStacks];
  return null;
}

/**
 * Vanilla EPF: 1 per Protection level for everything, 2 per level for the
 * matching specialised protection, 3 per Feather Falling level against falls.
 * Capped at 20 by the caller (see `damageReduction`).
 */
export function protectionPoints(armorStacks, source = null) {
  const list = armorList(armorStacks);
  if (!list) return 0;
  const f = sourceFlags(source);
  if (f.bypass) return 0;
  let epf = 0;
  for (const s of list) {
    if (!s || !s.item) continue;
    epf += getEnchant(s, 'protection');
    if (f.fire) epf += getEnchant(s, 'fire_protection') * 2;
    if (f.blast) epf += getEnchant(s, 'blast_protection') * 2;
    if (f.projectile) epf += getEnchant(s, 'projectile_protection') * 2;
    if (f.fall) epf += getEnchant(s, 'feather_falling') * 3;
  }
  return epf;
}

/**
 * Fraction of incoming damage the armour's protection enchantments remove,
 * 0..0.8. Use it as `damage *= 1 - damageReduction(armor, source)`.
 */
export function damageReduction(armorStacks, source = null) {
  const epf = protectionPoints(armorStacks, source);
  if (epf <= 0) return 0;
  return Math.min(20, epf) / 25;
}

/** Applies `damageReduction` to an amount. Convenience for combat.js. */
export function reducedDamage(amount, armorStacks, source = null) {
  return amount * (1 - damageReduction(armorStacks, source));
}

/**
 * Thorns retaliation. Returns the damage to deal back to the attacker, 0 when
 * no piece triggers. Vanilla: 15% chance per level, level>10 deals level-10.
 */
export function thornsDamage(armorStacks, rng = null) {
  const list = armorList(armorStacks);
  if (!list) return 0;
  const r = wrapRng(rng);
  let best = 0;
  for (const s of list) {
    const lv = getEnchant(s, 'thorns');
    if (lv > 0 && r.next() < lv * 0.15) {
      const dmg = lv > 10 ? lv - 10 : 1 + r.int(4);
      if (dmg > best) best = dmg;
    }
  }
  return best;
}

/** Extra knockback strength (in blocks) from Knockback / Punch. */
export function knockbackBonus(stack) {
  return getEnchant(stack, 'knockback') + getEnchant(stack, 'punch');
}

/** Seconds of fire Fire Aspect / Flame set the target alight for. */
export function fireAspectSeconds(stack) {
  const lv = getEnchant(stack, 'fire_aspect');
  return lv > 0 ? lv * 4 : 0;
}

/** Looting level, for mob drop rolls. */
export function lootingLevel(stack) { return getEnchant(stack, 'looting'); }
/** Fortune level, for block drop rolls. */
export function fortuneLevel(stack) { return getEnchant(stack, 'fortune'); }
/** True when the held tool should give the block itself. */
export function hasSilkTouch(stack) { return getEnchant(stack, 'silk_touch') > 0; }

/** Mining speed added by Efficiency: level^2 + 1. */
export function efficiencyBonus(stack) {
  const lv = getEnchant(stack, 'efficiency');
  return lv > 0 ? lv * lv + 1 : 0;
}

/** Arrow damage multiplier from Power (vanilla: +25% per level, +25% flat). */
export function powerBonus(stack) {
  const lv = getEnchant(stack, 'power');
  return lv > 0 ? lv * 0.25 + 0.25 : 0;
}

/**
 * Unbreaking roll: true when this use should actually consume durability.
 * Armour is protected 60 + 40/(level+1) percent of the time, everything else
 * 1/(level+1).
 */
export function shouldConsumeDurability(stack, rng = null, isArmor = false) {
  const lv = getEnchant(stack, 'unbreaking');
  if (lv <= 0) return true;
  const r = wrapRng(rng);
  if (isArmor) return r.next() < (0.6 + 0.4 / (lv + 1));
  return r.int(lv + 1) === 0;
}

/**
 * Mending: spends XP repairing the stack. Returns how much XP was consumed.
 * Vanilla heals 2 durability per XP point.
 */
export function mendingRepair(stack, xp) {
  if (!stack || getEnchant(stack, 'mending') <= 0) return 0;
  const dmg = stack.damage | 0;
  if (dmg <= 0) return 0;
  const repair = Math.min(xp * 2, dmg);
  stack.damage = dmg - repair;
  return Math.ceil(repair / 2);
}

/** Water-walking speed factor from Depth Strider, 0..1 (1 = full land speed). */
export function depthStriderFactor(bootsStack) {
  return Math.min(3, getEnchant(bootsStack, 'depth_strider')) / 3;
}

/** Extra ticks of breath from Respiration (15 seconds per level). */
export function respirationBonusTicks(helmetStack) {
  return getEnchant(helmetStack, 'respiration') * 300;
}

/** True when the item must not be dropped on death (Curse of Vanishing). */
export function vanishesOnDeath(stack) { return getEnchant(stack, 'vanishing_curse') > 0; }
/** True when the armour piece cannot be taken off (Curse of Binding). */
export function isBoundToWearer(stack) { return getEnchant(stack, 'binding_curse') > 0; }

/**
 * Total "enchantment value" of a stack, used for grindstone XP and for sorting
 * loot. Curses count for nothing.
 */
export function enchantmentValue(stack) { return xpFromItem(stack); }

export default ENCHANTMENTS;
