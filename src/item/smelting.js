// ============================================================================
// smelting.js - Furnace / blast furnace / smoker / campfire recipes and fuels.
//
// Four cooking "kinds" share one recipe table:
//
//   furnace        200 ticks   everything
//   blast_furnace  100 ticks   ores and metal items only
//   smoker         100 ticks   food only
//   campfire       600 ticks   food only, and it never awards experience
//
// A recipe is registered once with a *category* and the category decides which
// kinds pick it up, so there is exactly one place to edit when a recipe moves
// between machines.
//
// Nothing here touches the DOM, three.js or Game, so tools/validate.mjs can
// import this module in plain Node.
// ============================================================================
import { itemExists } from './items.js';

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/** Ticks one item takes in a normal furnace. */
export const FURNACE_TIME = 200;
/** Ticks one item takes in a blast furnace (twice as fast as a furnace). */
export const BLAST_TIME = 100;
/** Ticks one item takes in a smoker (twice as fast as a furnace). */
export const SMOKER_TIME = 100;
/** Ticks one item takes on a campfire (three times slower than a furnace). */
export const CAMPFIRE_TIME = 600;

/** The four cooking machines, in menu order. */
export const SMELT_KINDS = Object.freeze(['furnace', 'blast_furnace', 'smoker', 'campfire']);

/** Default cook time per kind, used when an item has no recipe for that kind. */
export const KIND_TIME = Object.freeze({
  furnace: FURNACE_TIME,
  blast_furnace: BLAST_TIME,
  smoker: SMOKER_TIME,
  campfire: CAMPFIRE_TIME,
});

/** Block name -> cooking kind, for opening the right screen on right-click. */
const BLOCK_KIND = Object.freeze({
  furnace: 'furnace',
  blast_furnace: 'blast_furnace',
  smoker: 'smoker',
  campfire: 'campfire',
  soul_campfire: 'campfire',
});

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/**
 * kind -> Map(inputItemName -> recipe record).
 * A record is `{ kind, input, output, item, count, xp, time }`; `item` is an
 * alias of `output` and `String(record)` yields the output name, so consumers
 * that expected a bare item name still behave sanely.
 */
export const SMELTING = new Map();
for (const k of SMELT_KINDS) SMELTING.set(k, new Map());

/** Flat list of every registered record across all kinds (recipe book / JEI). */
export const SMELTING_RECIPES = [];

/** Item names referenced by a recipe or fuel entry that item/items.js lacks. */
export const UNKNOWN_ITEMS = [];

// output item name -> Set of input item names (any kind)
const BY_OUTPUT = new Map();

// Which kinds a category feeds, and the experience multiplier for each.
// Campfires cook but never drop XP, hence the 0.
const CATEGORY_KINDS = {
  ore: [['furnace', FURNACE_TIME, 1], ['blast_furnace', BLAST_TIME, 1]],
  metal: [['furnace', FURNACE_TIME, 1], ['blast_furnace', BLAST_TIME, 1]],
  food: [['furnace', FURNACE_TIME, 1], ['smoker', SMOKER_TIME, 1], ['campfire', CAMPFIRE_TIME, 0]],
  misc: [['furnace', FURNACE_TIME, 1]],
};

/** Accepts an item name, an item definition or an ItemStack and returns a name. */
function nameOf(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    if (typeof v.item === 'string') return v.item;
    if (v.item && typeof v.item === 'object' && typeof v.item.name === 'string') return v.item.name;
    if (typeof v.name === 'string') return v.name;
  }
  return '';
}

function note(name) {
  if (name && !itemExists(name) && !UNKNOWN_ITEMS.includes(name)) UNKNOWN_ITEMS.push(name);
}

function makeRecord(kind, input, output, count, xp, time) {
  const r = { kind, input, output, item: output, count, xp, time };
  // Cheap compatibility net: `${record}` and String(record) give the item name.
  Object.defineProperty(r, 'toString', { value: () => output, enumerable: false });
  return Object.freeze(r);
}

/**
 * Registers one cooking recipe. `category` picks the machines:
 * 'ore' and 'metal' -> furnace + blast furnace, 'food' -> furnace + smoker +
 * campfire, 'misc' -> furnace only.
 */
export function defineSmelting(input, output, xp = 0.1, category = 'misc', count = 1) {
  const kinds = CATEGORY_KINDS[category] || CATEGORY_KINDS.misc;
  note(input); note(output);
  for (const [kind, time, xpMul] of kinds) {
    const table = SMELTING.get(kind);
    if (!table || table.has(input)) continue;
    const rec = makeRecord(kind, input, output, count, Math.round(xp * xpMul * 1000) / 1000, time);
    table.set(input, rec);
    SMELTING_RECIPES.push(rec);
  }
  let set = BY_OUTPUT.get(output);
  if (!set) { set = new Set(); BY_OUTPUT.set(output, set); }
  set.add(input);
  return output;
}

const smeltAll = (pairs, category) => { for (const [i, o, xp] of pairs) defineSmelting(i, o, xp, category); };

// ---------------------------------------------------------------------------
// Ores -> ingots, gems and dusts
// ---------------------------------------------------------------------------

smeltAll([
  ['iron_ore', 'iron_ingot', 0.7],
  ['deepslate_iron_ore', 'iron_ingot', 0.7],
  ['raw_iron', 'iron_ingot', 0.7],
  ['gold_ore', 'gold_ingot', 1.0],
  ['deepslate_gold_ore', 'gold_ingot', 1.0],
  ['nether_gold_ore', 'gold_ingot', 1.0],
  ['raw_gold', 'gold_ingot', 1.0],
  ['copper_ore', 'copper_ingot', 0.7],
  ['deepslate_copper_ore', 'copper_ingot', 0.7],
  ['raw_copper', 'copper_ingot', 0.7],
  ['coal_ore', 'coal', 0.1],
  ['deepslate_coal_ore', 'coal', 0.1],
  ['diamond_ore', 'diamond', 1.0],
  ['deepslate_diamond_ore', 'diamond', 1.0],
  ['emerald_ore', 'emerald', 1.0],
  ['deepslate_emerald_ore', 'emerald', 1.0],
  ['lapis_ore', 'lapis_lazuli', 0.2],
  ['deepslate_lapis_ore', 'lapis_lazuli', 0.2],
  ['redstone_ore', 'redstone', 0.7],
  ['deepslate_redstone_ore', 'redstone', 0.7],
  ['nether_quartz_ore', 'quartz', 0.2],
  ['ancient_debris', 'netherite_scrap', 2.0],
], 'ore');

// ---------------------------------------------------------------------------
// Scrapping worn metal gear back into nuggets
// ---------------------------------------------------------------------------

const TOOL_KINDS = ['sword', 'shovel', 'pickaxe', 'axe', 'hoe'];
const ARMOR_KINDS = ['helmet', 'chestplate', 'leggings', 'boots'];

for (const k of TOOL_KINDS) defineSmelting('iron_' + k, 'iron_nugget', 0.1, 'metal');
for (const k of ARMOR_KINDS) defineSmelting('iron_' + k, 'iron_nugget', 0.1, 'metal');
for (const k of ARMOR_KINDS) defineSmelting('chainmail_' + k, 'iron_nugget', 0.1, 'metal');
defineSmelting('iron_horse_armor', 'iron_nugget', 0.1, 'metal');

for (const k of TOOL_KINDS) defineSmelting('golden_' + k, 'gold_nugget', 0.1, 'metal');
for (const k of ARMOR_KINDS) defineSmelting('golden_' + k, 'gold_nugget', 0.1, 'metal');
defineSmelting('golden_horse_armor', 'gold_nugget', 0.1, 'metal');

// ---------------------------------------------------------------------------
// Food - the only things a smoker or a campfire will touch
// ---------------------------------------------------------------------------

smeltAll([
  ['porkchop', 'cooked_porkchop', 0.35],
  ['beef', 'cooked_beef', 0.35],
  ['chicken', 'cooked_chicken', 0.35],
  ['mutton', 'cooked_mutton', 0.35],
  ['rabbit', 'cooked_rabbit', 0.35],
  ['cod', 'cooked_cod', 0.35],
  ['salmon', 'cooked_salmon', 0.35],
  ['potato', 'baked_potato', 0.35],
  ['kelp', 'dried_kelp', 0.1],
], 'food');

// ---------------------------------------------------------------------------
// Everything else - furnace only
// ---------------------------------------------------------------------------

smeltAll([
  // sand and stone
  ['sand', 'glass', 0.1],
  ['red_sand', 'glass', 0.1],
  ['cobblestone', 'stone', 0.1],
  ['stone', 'smooth_stone', 0.1],
  ['cobbled_deepslate', 'deepslate', 0.1],
  ['basalt', 'smooth_basalt', 0.1],
  // clay and bricks
  ['clay_ball', 'brick', 0.3],
  ['clay', 'terracotta', 0.35],
  ['netherrack', 'nether_brick', 0.1],
  // cracked variants
  ['stone_bricks', 'cracked_stone_bricks', 0.1],
  ['deepslate_bricks', 'cracked_deepslate_bricks', 0.1],
  ['deepslate_tiles', 'cracked_deepslate_tiles', 0.1],
  ['nether_bricks', 'cracked_nether_bricks', 0.1],
  ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 0.1],
  // smooth variants
  ['quartz_block', 'smooth_quartz', 0.1],
  ['sandstone', 'smooth_sandstone', 0.1],
  ['red_sandstone', 'smooth_red_sandstone', 0.1],
  // odds and ends
  ['cactus', 'green_dye', 1.0],
  ['sea_pickle', 'lime_dye', 0.1],
  ['wet_sponge', 'sponge', 0.15],
  ['chorus_fruit', 'popped_chorus_fruit', 0.1],
], 'misc');

// Dyed terracotta -> glazed terracotta (16 colours).
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
for (const c of COLORS) defineSmelting(c + '_terracotta', c + '_glazed_terracotta', 0.1, 'misc');

// ---------------------------------------------------------------------------
// Charcoal - every overworld log, stripped log, wood and bamboo block.
// Crimson and warped stems are fungus, not wood: they neither burn nor char.
// ---------------------------------------------------------------------------

/** Wood families whose items burn (i.e. everything except the nether fungi). */
export const BURNABLE_WOODS = Object.freeze([
  'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo',
]);

/** The log-shaped item names of one wood family. */
function logNames(w) {
  if (w === 'bamboo') return ['bamboo_block', 'stripped_bamboo_block'];
  return [w + '_log', 'stripped_' + w + '_log', w + '_wood', 'stripped_' + w + '_wood'];
}

for (const w of BURNABLE_WOODS) {
  for (const n of logNames(w)) defineSmelting(n, 'charcoal', 0.15, 'misc');
}

// ---------------------------------------------------------------------------
// Fuels
// ---------------------------------------------------------------------------

/** item name -> burn time in ticks. One coal (1600) smelts 8 items. */
export const FUELS = new Map();

/** Registers a fuel. Unknown names are dropped but recorded for validation. */
function addFuel(name, ticks) {
  if (!name || ticks <= 0) return;
  note(name);
  if (itemExists(name)) FUELS.set(name, ticks);
}

/** Registers a fuel only if the item exists; used by the family sweeps. */
function maybeFuel(name, ticks) {
  if (name && itemExists(name)) FUELS.set(name, ticks);
}

// --- the heavyweights ---
addFuel('lava_bucket', 20000);
addFuel('coal_block', 16000);
addFuel('dried_kelp_block', 4000);
addFuel('blaze_rod', 2400);
addFuel('coal', 1600);
addFuel('charcoal', 1600);

// --- wooden families -------------------------------------------------------
// logs / planks / fences / stairs / trapdoors / plates 300, slabs 150,
// doors and signs 200, hanging signs 800, buttons 100, boats 1200.
for (const w of BURNABLE_WOODS) {
  for (const n of logNames(w)) maybeFuel(n, 300);
  maybeFuel(w + '_planks', 300);
  maybeFuel(w + '_stairs', 300);
  maybeFuel(w + '_fence', 300);
  maybeFuel(w + '_fence_gate', 300);
  maybeFuel(w + '_trapdoor', 300);
  maybeFuel(w + '_pressure_plate', 300);
  maybeFuel(w + '_slab', 150);
  maybeFuel(w + '_door', 200);
  maybeFuel(w + '_sign', 200);
  maybeFuel(w + '_hanging_sign', 800);
  maybeFuel(w + '_button', 100);
  if (w === 'bamboo') {
    maybeFuel('bamboo_raft', 1200);
    maybeFuel('bamboo_chest_raft', 1200);
  } else {
    maybeFuel(w + '_boat', 1200);
    maybeFuel(w + '_chest_boat', 1200);
  }
}
maybeFuel('bamboo_mosaic', 300);
maybeFuel('bamboo_mosaic_stairs', 300);
maybeFuel('bamboo_mosaic_slab', 150);
maybeFuel('mangrove_roots', 300);

// --- saplings and other cheap kindling ---
for (const s of ['oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule',
  'azalea', 'flowering_azalea', 'dead_bush']) maybeFuel(s, 100);
addFuel('stick', 100);
addFuel('bamboo', 50);
addFuel('scaffolding', 50);

// --- wooden tools and gear ---
for (const k of TOOL_KINDS) addFuel('wooden_' + k, 200);
addFuel('bowl', 200);
addFuel('bow', 300);
addFuel('crossbow', 300);
addFuel('fishing_rod', 300);

// --- wooden utility blocks ---
for (const n of ['crafting_table', 'chest', 'trapped_chest', 'barrel', 'bookshelf',
  'chiseled_bookshelf', 'lectern', 'composter', 'note_block', 'jukebox', 'ladder',
  'daylight_detector', 'loom', 'smithing_table', 'fletching_table', 'cartography_table',
  'beehive', 'bee_nest']) addFuel(n, 300);

// --- wool, carpets and banners ---
for (const c of COLORS) {
  maybeFuel(c + '_wool', 100);
  maybeFuel(c + '_carpet', 67);
  maybeFuel(c + '_banner', 300);
}

/** Every registered fuel name, longest-burning first. */
export const FUEL_NAMES = Object.freeze([...FUELS.keys()].sort((a, b) => FUELS.get(b) - FUELS.get(a)));

/** Fuels that leave something behind in the fuel slot when consumed. */
const FUEL_REMAINDER = Object.freeze({ lava_bucket: 'bucket' });

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Looks up a cooking recipe. `kind` is 'furnace' | 'blast_furnace' | 'smoker' |
 * 'campfire'; `itemName` may be a name, an item def or an ItemStack.
 * Returns `{ kind, input, output, item, count, xp, time }` or null.
 */
export function smeltResult(kind, itemName) {
  const table = SMELTING.get(kind);
  if (!table) return null;
  return table.get(nameOf(itemName)) || null;
}

/** Just the output item name for a cooking recipe, or null. */
export function smeltOutput(kind, itemName) {
  const r = smeltResult(kind, itemName);
  return r ? r.output : null;
}

/** True when this machine accepts the item at all. */
export function canSmelt(kind, itemName) {
  return smeltResult(kind, itemName) !== null;
}

/** Experience awarded for one finished item. Campfires always give 0. */
export function smeltXp(kind, itemName) {
  const r = smeltResult(kind, itemName);
  return r ? r.xp : 0;
}

/** Cook time in ticks for one item, or 0 when the machine will not take it. */
export function smeltTime(kind, itemName) {
  const r = smeltResult(kind, itemName);
  return r ? r.time : 0;
}

/**
 * Experience for a batch. Furnaces store a fractional total and round it down
 * when the player pulls the output, so this returns the raw float.
 */
export function smeltXpForCount(kind, itemName, count) {
  return smeltXp(kind, itemName) * (count > 0 ? count : 0);
}

/** Burn time in ticks, or 0 when the item is not a fuel. */
export function fuelTicks(itemName) {
  return FUELS.get(nameOf(itemName)) || 0;
}

/** True when the item can go in a furnace fuel slot. */
export function isFuel(itemName) {
  return FUELS.has(nameOf(itemName));
}

/** What is left in the fuel slot after burning (a lava bucket leaves a bucket). */
export function fuelRemainder(itemName) {
  return FUEL_REMAINDER[nameOf(itemName)] || null;
}

/** How many items one unit of this fuel cooks in the given machine. */
export function fuelYield(itemName, kind = 'furnace') {
  const t = KIND_TIME[kind] || FURNACE_TIME;
  return fuelTicks(itemName) / t;
}

/** All recipes for one machine, in registration order. */
export function smeltingRecipes(kind) {
  const table = SMELTING.get(kind);
  return table ? [...table.values()] : [];
}

/** Every input that cooks into `outputName`, across all machines. */
export function smeltingInputsFor(outputName) {
  const set = BY_OUTPUT.get(nameOf(outputName));
  return set ? [...set] : [];
}

/** Which machine a block opens: 'furnace', 'smoker', ... or null. */
export function kindForBlock(blockName) {
  return BLOCK_KIND[nameOf(blockName)] || null;
}

/** True when the machine cooks food (smoker, campfire) rather than ore. */
export function isFoodKind(kind) {
  return kind === 'smoker' || kind === 'campfire';
}

export default SMELTING;
