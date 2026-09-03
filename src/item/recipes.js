// ============================================================================
// recipes.js - The crafting recipe registry.
//
// Contains every vanilla-style crafting recipe (shaped + shapeless), the item
// tag system used by ingredients ('#planks', '#logs', '#wool', ...), the grid
// matcher, the "special" dynamic recipes (repair, banners, fireworks, maps,
// book copying, leather dyeing, suspicious stew, tipped arrows) and the
// recipe-book index.
//
// Nothing here touches the DOM, three.js or Game state at module scope, so
// tools/validate.mjs can import it in plain Node.
// ============================================================================
import { ITEMS, getItem, itemExists } from './items.js';

// ---------------------------------------------------------------------------
// 0. Shared vocabulary
// ---------------------------------------------------------------------------

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const DYE_HEX = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52,
  0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];

const OVERWORLD_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
const NETHER_WOODS = ['crimson', 'warped'];

/** Describes one wood family so the loops below stay data-driven. */
function woodSet(name, nether) {
  const log = nether ? `${name}_stem` : `${name}_log`;
  const wood = nether ? `${name}_hyphae` : `${name}_wood`;
  return {
    name, nether: !!nether,
    log, wood, strippedLog: `stripped_${log}`, strippedWood: `stripped_${wood}`,
    planks: `${name}_planks`,
    boat: nether ? null : `${name}_boat`,
    chestBoat: nether ? null : `${name}_chest_boat`,
  };
}
const WOOD_SETS = [
  ...OVERWORLD_WOODS.map((w) => woodSet(w, false)),
  ...NETHER_WOODS.map((w) => woodSet(w, true)),
];

const rep = (n, v) => new Array(n).fill(v);

// ---------------------------------------------------------------------------
// 1. Tags
// ---------------------------------------------------------------------------

/** '#planks' -> ['oak_planks', ...]. Ingredients may name any of these. */
export const TAGS = {};
const TAG_SETS = new Map();

/** Registers (or replaces) an item tag. Names are stored with their '#'. */
function tag(name, items) {
  const list = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || seen.has(it)) continue;
    seen.add(it);
    list.push(it);
  }
  TAGS[name] = list;
  TAG_SETS.set(name, seen);
  return name;
}

const PLANKS = WOOD_SETS.map((w) => w.planks).concat('bamboo_planks');
const LOG_ITEMS = [];
for (const w of WOOD_SETS) {
  tag(`#${w.name}_logs`, [w.log, w.wood, w.strippedLog, w.strippedWood]);
  LOG_ITEMS.push(w.log, w.wood, w.strippedLog, w.strippedWood);
}
tag('#bamboo_blocks', ['bamboo_block', 'stripped_bamboo_block']);

tag('#planks', PLANKS);
tag('#logs', LOG_ITEMS.concat('bamboo_block', 'stripped_bamboo_block'));
tag('#logs_that_burn', LOG_ITEMS.filter((n) => !n.includes('crimson') && !n.includes('warped')));
tag('#crimson_stems', ['crimson_stem', 'crimson_hyphae', 'stripped_crimson_stem', 'stripped_crimson_hyphae']);
tag('#warped_stems', ['warped_stem', 'warped_hyphae', 'stripped_warped_stem', 'stripped_warped_hyphae']);

const WOOD_KINDS = OVERWORLD_WOODS.concat(NETHER_WOODS, 'bamboo');
tag('#wooden_slabs', WOOD_KINDS.map((w) => `${w}_slab`).concat('bamboo_mosaic_slab'));
tag('#wooden_stairs', WOOD_KINDS.map((w) => `${w}_stairs`).concat('bamboo_mosaic_stairs'));
tag('#wooden_doors', WOOD_KINDS.map((w) => `${w}_door`));
tag('#wooden_trapdoors', WOOD_KINDS.map((w) => `${w}_trapdoor`));
tag('#wooden_buttons', WOOD_KINDS.map((w) => `${w}_button`));
tag('#wooden_pressure_plates', WOOD_KINDS.map((w) => `${w}_pressure_plate`));
tag('#wooden_fences', WOOD_KINDS.map((w) => `${w}_fence`));
tag('#fence_gates', WOOD_KINDS.map((w) => `${w}_fence_gate`));
tag('#signs', WOOD_KINDS.map((w) => `${w}_sign`));
tag('#hanging_signs', WOOD_KINDS.map((w) => `${w}_hanging_sign`));
tag('#doors', TAGS['#wooden_doors'].concat('iron_door'));
tag('#trapdoors', TAGS['#wooden_trapdoors'].concat('iron_trapdoor'));
tag('#buttons', TAGS['#wooden_buttons'].concat('stone_button', 'polished_blackstone_button'));
tag('#saplings', ['oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling', 'acacia_sapling',
  'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule', 'azalea', 'flowering_azalea']);
tag('#leaves', ['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves',
  'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves']);

tag('#wool', COLORS.map((c) => `${c}_wool`));
tag('#wool_carpets', COLORS.map((c) => `${c}_carpet`));
tag('#beds', COLORS.map((c) => `${c}_bed`));
tag('#banners', COLORS.map((c) => `${c}_banner`));
tag('#candles', COLORS.map((c) => `${c}_candle`).concat('candle'));
tag('#dyes', COLORS.map((c) => `${c}_dye`));
tag('#shulker_boxes', ['shulker_box'].concat(COLORS.map((c) => `${c}_shulker_box`)));
tag('#terracotta', ['terracotta'].concat(COLORS.map((c) => `${c}_terracotta`)));
tag('#concrete_powder', COLORS.map((c) => `${c}_concrete_powder`));
tag('#stained_glass', COLORS.map((c) => `${c}_stained_glass`));
tag('#stained_glass_panes', COLORS.map((c) => `${c}_stained_glass_pane`));

tag('#coals', ['coal', 'charcoal']);
tag('#sand', ['sand', 'red_sand']);
tag('#smelts_to_glass', ['sand', 'red_sand']);
tag('#stone_tool_materials', ['cobblestone', 'blackstone', 'cobbled_deepslate']);
tag('#stone_crafting_materials', ['cobblestone', 'blackstone', 'cobbled_deepslate']);
tag('#stone_bricks', ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks']);
tag('#soul_fire_base_blocks', ['soul_sand', 'soul_soil']);
tag('#anvil', ['anvil', 'chipped_anvil', 'damaged_anvil']);
tag('#rails', ['rail', 'powered_rail', 'detector_rail', 'activator_rail']);
tag('#arrows', ['arrow', 'spectral_arrow', 'tipped_arrow']);
tag('#fishes', ['cod', 'salmon', 'tropical_fish', 'pufferfish']);
tag('#small_flowers', ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'wither_rose', 'torchflower']);
tag('#tall_flowers', ['sunflower', 'lilac', 'rose_bush', 'peony', 'pitcher_plant']);
tag('#flowers', TAGS['#small_flowers'].concat(TAGS['#tall_flowers'], 'flowering_azalea', 'flowering_azalea_leaves'));
tag('#boats', OVERWORLD_WOODS.map((w) => `${w}_boat`).concat('bamboo_raft'));
tag('#chest_boats', OVERWORLD_WOODS.map((w) => `${w}_chest_boat`).concat('bamboo_chest_raft'));
tag('#music_discs', ['music_disc_13', 'music_disc_cat', 'music_disc_blocks', 'music_disc_chirp',
  'music_disc_far', 'music_disc_mall', 'music_disc_mellohi', 'music_disc_stal', 'music_disc_strad',
  'music_disc_ward', 'music_disc_11', 'music_disc_wait', 'music_disc_otherside', 'music_disc_5',
  'music_disc_pigstep', 'music_disc_relic']);
tag('#trim_templates', ['coast_armor_trim_smithing_template', 'dune_armor_trim_smithing_template',
  'eye_armor_trim_smithing_template', 'host_armor_trim_smithing_template',
  'raiser_armor_trim_smithing_template', 'rib_armor_trim_smithing_template',
  'sentry_armor_trim_smithing_template', 'shaper_armor_trim_smithing_template',
  'silence_armor_trim_smithing_template', 'snout_armor_trim_smithing_template',
  'spire_armor_trim_smithing_template', 'tide_armor_trim_smithing_template',
  'vex_armor_trim_smithing_template', 'ward_armor_trim_smithing_template',
  'wayfinder_armor_trim_smithing_template', 'wild_armor_trim_smithing_template']);
tag('#trim_materials', ['iron_ingot', 'copper_ingot', 'gold_ingot', 'lapis_lazuli', 'emerald',
  'diamond', 'netherite_ingot', 'redstone', 'quartz', 'amethyst_shard']);

for (const ore of ['coal', 'iron', 'copper', 'gold', 'diamond', 'emerald', 'lapis', 'redstone']) {
  tag(`#${ore}_ores`, [`${ore}_ore`, `deepslate_${ore}_ore`]);
}
tag('#gold_ores', ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore']);

tag('#leather_armor', ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots',
  'leather_horse_armor']);

// ---------------------------------------------------------------------------
// 2. Registry core
// ---------------------------------------------------------------------------

/** Every registered recipe, in registration order. */
export const RECIPES = [];

const BY_OUTPUT = new Map();      // item name -> recipe[]
const BY_INGREDIENT = new Map();  // item name -> recipe[]  (tags expanded)
const BY_ID = new Map();
const SHAPED_BY_SIZE = new Map(); // 'wxh' -> recipe[]
const SHAPELESS_BY_COUNT = new Map(); // ingredient count -> recipe[]

/** True when `ing` is a tag reference such as '#planks'. */
function isTag(ing) {
  return typeof ing === 'string' && ing.charCodeAt(0) === 35;
}

/** All concrete item names an ingredient can be satisfied by. */
function expandIngredient(ing) {
  if (isTag(ing)) return TAGS[ing] || [];
  if (Array.isArray(ing)) {
    const out = [];
    for (const i of ing) out.push(...expandIngredient(i));
    return out;
  }
  if (ing && typeof ing === 'object' && ing.item) return [ing.item];
  return typeof ing === 'string' ? [ing] : [];
}

/**
 * True when a stack satisfies an ingredient. Empty slots never match, and a
 * slot must hold at least one item.
 */
export function matchesIngredient(ing, stack) {
  if (!stack || !stack.item || (stack.count !== undefined && stack.count <= 0)) return false;
  if (typeof ing === 'string') {
    if (ing.charCodeAt(0) === 35) {
      const set = TAG_SETS.get(ing);
      return !!set && set.has(stack.item);
    }
    return ing === stack.item;
  }
  if (Array.isArray(ing)) {
    for (const i of ing) if (matchesIngredient(i, stack)) return true;
    return false;
  }
  if (ing && typeof ing === 'object' && ing.item) return ing.item === stack.item;
  return false;
}

/** Accepts 'stone', ['stone', 4] or { item, count, ...extra }. */
function normalizeOutput(o) {
  if (typeof o === 'string') return { item: o, count: 1 };
  if (Array.isArray(o)) {
    const out = { item: o[0], count: o[1] === undefined ? 1 : o[1] };
    if (o[2]) Object.assign(out, o[2]);
    return out;
  }
  const out = { item: o.item, count: o.count === undefined ? 1 : o.count };
  for (const k in o) if (k !== 'item' && k !== 'count') out[k] = o[k];
  return out;
}

function makeId(base) {
  if (!BY_ID.has(base)) return base;
  let n = 2;
  while (BY_ID.has(base + '_' + n)) n++;
  return base + '_' + n;
}

/** Indexes a recipe for recipesFor()/craftableFrom() and the grid matcher. */
function register(r) {
  r.id = r.id || makeId(r.output.item);
  BY_ID.set(r.id, r);
  RECIPES.push(r);

  let outList = BY_OUTPUT.get(r.output.item);
  if (!outList) BY_OUTPUT.set(r.output.item, (outList = []));
  outList.push(r);

  const seen = new Set();
  for (const ing of r.ingredients) {
    for (const name of expandIngredient(ing)) {
      if (seen.has(name)) continue;
      seen.add(name);
      let l = BY_INGREDIENT.get(name);
      if (!l) BY_INGREDIENT.set(name, (l = []));
      l.push(r);
    }
  }

  // Aggregate required counts once, for the recipe book.
  const req = new Map();
  for (const ing of r.ingredients) {
    const key = typeof ing === 'string' ? ing : JSON.stringify(ing);
    const e = req.get(key);
    if (e) e.count++;
    else req.set(key, { ing, count: 1 });
  }
  r.req = [...req.values()];

  if (r.type === 'shaped') {
    const key = r.w + 'x' + r.h;
    let l = SHAPED_BY_SIZE.get(key);
    if (!l) SHAPED_BY_SIZE.set(key, (l = []));
    l.push(r);
  } else if (r.type === 'shapeless') {
    const n = r.ingredients.length;
    let l = SHAPELESS_BY_COUNT.get(n);
    if (!l) SHAPELESS_BY_COUNT.set(n, (l = []));
    l.push(r);
  }
  return r;
}

/** Trims blank rows/columns off a pattern and resolves the key characters. */
function normalizePattern(pattern, keys) {
  const rows = pattern.map((r) => String(r));
  const h0 = rows.length;
  let w0 = 0;
  for (const r of rows) w0 = Math.max(w0, r.length);
  const cellAt = (x, y) => {
    const c = rows[y][x];
    if (c === undefined || c === ' ' || c === '.') return null;
    const ing = keys[c];
    if (ing === undefined) throw new Error(`recipe pattern uses undefined key '${c}'`);
    return ing;
  };
  let x0 = w0, y0 = h0, x1 = -1, y1 = -1;
  for (let y = 0; y < h0; y++) {
    for (let x = 0; x < w0; x++) {
      if (!cellAt(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { w: 0, h: 0, cells: [] };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const cells = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) cells[y * w + x] = cellAt(x + x0, y + y0);
  }
  return { w, h, cells };
}

/**
 * Registers a shaped recipe.
 * `pattern` is an array of up to 3 strings, `keys` maps each pattern character
 * to an item name or a '#tag'. Blank cells are ' ' or '.'.
 */
export function shaped(output, pattern, keys = {}, opts = {}) {
  const out = normalizeOutput(output);
  const { w, h, cells } = normalizePattern(pattern, keys);
  const ingredients = cells.filter(Boolean);
  return register({
    type: 'shaped',
    id: opts.id || null,
    output: out,
    pattern: pattern.slice(),
    keys: { ...keys },
    w, h, cells,
    ingredients,
    mirror: opts.mirror !== false,
    group: opts.group || (ITEMS[out.item] && ITEMS[out.item].group) || 'misc',
    category: opts.category || null,
    maxDim: Math.max(w, h),
  });
}

/** Registers a shapeless recipe from a flat list of ingredients (max 9). */
export function shapeless(output, ingredients, opts = {}) {
  const out = normalizeOutput(output);
  const ings = [].concat(ingredients);
  return register({
    type: 'shapeless',
    id: opts.id || null,
    output: out,
    ingredients: ings,
    group: opts.group || (ITEMS[out.item] && ITEMS[out.item].group) || 'misc',
    category: opts.category || null,
    maxDim: ings.length <= 4 ? 2 : 3,
  });
}

/** Registers a smithing-table recipe (netherite upgrades). */
export function smithing(template, base, addition, output, opts = {}) {
  const out = normalizeOutput(output);
  return register({
    type: 'smithing',
    id: opts.id || null,
    output: out,
    template, base, addition,
    ingredients: [template, base, addition],
    group: opts.group || 'equipment',
    category: 'equipment',
    maxDim: 3,
  });
}

// Compact aliases used by the bulk data below.
const sh = shaped;
const sl = shapeless;

// ===========================================================================
// 3. Wood families
// ===========================================================================

for (const s of WOOD_SETS) {
  const P = s.planks;
  sl([P, 4], [`#${s.name}_logs`], { group: 'planks' });
  sh([s.wood, 3], ['LL', 'LL'], { L: s.log }, { group: 'bark' });
  sh([s.strippedWood, 3], ['LL', 'LL'], { L: s.strippedLog }, { group: 'bark' });
  sh([`${s.name}_stairs`, 4], ['P  ', 'PP ', 'PPP'], { P }, { group: 'wooden_stairs' });
  sh([`${s.name}_slab`, 6], ['PPP'], { P }, { group: 'wooden_slab' });
  sh([`${s.name}_fence`, 3], ['PSP', 'PSP'], { P, S: 'stick' }, { group: 'wooden_fence' });
  sh([`${s.name}_fence_gate`, 1], ['SPS', 'SPS'], { P, S: 'stick' }, { group: 'wooden_fence_gate' });
  sh([`${s.name}_door`, 3], ['PP', 'PP', 'PP'], { P }, { group: 'wooden_door' });
  sh([`${s.name}_trapdoor`, 2], ['PPP', 'PPP'], { P }, { group: 'wooden_trapdoor' });
  sl([`${s.name}_button`, 1], [P], { group: 'wooden_button' });
  sh([`${s.name}_pressure_plate`, 1], ['PP'], { P }, { group: 'wooden_pressure_plate' });
  sh([`${s.name}_sign`, 3], ['PPP', 'PPP', ' S '], { P, S: 'stick' }, { group: 'sign' });
  sh([`${s.name}_hanging_sign`, 6], ['C C', 'LLL', 'LLL'], { C: 'chain', L: s.strippedLog }, { group: 'hanging_sign' });
  if (s.boat) {
    sh([s.boat, 1], ['P P', 'PPP'], { P }, { group: 'boat' });
    sl([s.chestBoat, 1], ['chest', s.boat], { group: 'chest_boat' });
  }
}

// Bamboo behaves like wood but starts from the bamboo block.
sh(['bamboo_block', 1], ['BBB', 'BBB', 'BBB'], { B: 'bamboo' });
sl(['bamboo_planks', 2], ['#bamboo_blocks'], { group: 'planks' });
sh(['bamboo_mosaic', 1], ['S', 'S'], { S: 'bamboo_slab' });
sh(['bamboo_stairs', 4], ['P  ', 'PP ', 'PPP'], { P: 'bamboo_planks' }, { group: 'wooden_stairs' });
sh(['bamboo_slab', 6], ['PPP'], { P: 'bamboo_planks' }, { group: 'wooden_slab' });
sh(['bamboo_mosaic_stairs', 4], ['P  ', 'PP ', 'PPP'], { P: 'bamboo_mosaic' }, { group: 'wooden_stairs' });
sh(['bamboo_mosaic_slab', 6], ['PPP'], { P: 'bamboo_mosaic' }, { group: 'wooden_slab' });
sh(['bamboo_fence', 3], ['PSP', 'PSP'], { P: 'bamboo_planks', S: 'bamboo' }, { group: 'wooden_fence' });
sh(['bamboo_fence_gate', 1], ['SPS', 'SPS'], { P: 'bamboo_planks', S: 'bamboo' }, { group: 'wooden_fence_gate' });
sh(['bamboo_door', 3], ['PP', 'PP', 'PP'], { P: 'bamboo_planks' }, { group: 'wooden_door' });
sh(['bamboo_trapdoor', 2], ['PPP', 'PPP'], { P: 'bamboo_planks' }, { group: 'wooden_trapdoor' });
sl(['bamboo_button', 1], ['bamboo_planks'], { group: 'wooden_button' });
sh(['bamboo_pressure_plate', 1], ['PP'], { P: 'bamboo_planks' }, { group: 'wooden_pressure_plate' });
sh(['bamboo_sign', 3], ['PPP', 'PPP', ' S '], { P: 'bamboo_planks', S: 'stick' }, { group: 'sign' });
sh(['bamboo_hanging_sign', 6], ['C C', 'LLL', 'LLL'], { C: 'chain', L: 'stripped_bamboo_block' }, { group: 'hanging_sign' });
sh(['bamboo_raft', 1], ['P P', 'PPP'], { P: 'bamboo_planks' }, { group: 'boat' });
sl(['bamboo_chest_raft', 1], ['chest', 'bamboo_raft'], { group: 'chest_boat' });

sh(['stick', 4], ['P', 'P'], { P: '#planks' });
sh(['stick', 1], ['B', 'B'], { B: 'bamboo' });
sh(['ladder', 3], ['S S', 'SSS', 'S S'], { S: 'stick' });
sh(['bowl', 4], ['P P', ' P '], { P: '#planks' });
sh(['crafting_table', 1], ['PP', 'PP'], { P: '#planks' });
sh(['chest', 1], ['PPP', 'P P', 'PPP'], { P: '#planks' });
sl(['trapped_chest', 1], ['chest', 'tripwire_hook']);
sh(['ender_chest', 1], ['OOO', 'OEO', 'OOO'], { O: 'obsidian', E: 'ender_eye' });
sh(['barrel', 1], ['PSP', 'P P', 'PSP'], { P: '#planks', S: '#wooden_slabs' });
sh(['bookshelf', 1], ['PPP', 'BBB', 'PPP'], { P: '#planks', B: 'book' });
sh(['chiseled_bookshelf', 1], ['PPP', 'SSS', 'PPP'], { P: '#planks', S: '#wooden_slabs' });
sh(['lectern', 1], ['SSS', ' B ', ' S '], { S: '#wooden_slabs', B: 'bookshelf' });
sh(['note_block', 1], ['PPP', 'PRP', 'PPP'], { P: '#planks', R: 'redstone' });
sh(['jukebox', 1], ['PPP', 'PDP', 'PPP'], { P: '#planks', D: 'diamond' });
sh(['composter', 1], ['S S', 'S S', 'SSS'], { S: '#wooden_slabs' });
sh(['beehive', 1], ['PPP', 'HHH', 'PPP'], { P: '#planks', H: 'honeycomb' });
sh(['loom', 1], ['SS', 'PP'], { S: 'string', P: '#planks' });
sh(['cartography_table', 1], ['AA', 'PP', 'PP'], { A: 'paper', P: '#planks' });
sh(['fletching_table', 1], ['FF', 'PP', 'PP'], { F: 'flint', P: '#planks' });
sh(['smithing_table', 1], ['II', 'PP', 'PP'], { I: 'iron_ingot', P: '#planks' });
sh(['grindstone', 1], ['SLS', 'P P'], { S: 'stick', L: 'stone_slab', P: '#planks' });
sh(['stonecutter', 1], [' I ', 'SSS'], { I: 'iron_ingot', S: 'stone' });
sh(['campfire', 1], [' S ', 'SCS', 'LLL'], { S: 'stick', C: '#coals', L: '#logs_that_burn' });
sh(['soul_campfire', 1], [' S ', 'SCS', 'LLL'], { S: 'stick', C: '#soul_fire_base_blocks', L: '#logs_that_burn' });
sh(['scaffolding', 6], ['BSB', 'B B', 'B B'], { B: 'bamboo', S: 'string' });
sh(['smoker', 1], [' L ', 'LFL', ' L '], { L: '#logs_that_burn', F: 'furnace' });
sh(['blast_furnace', 1], ['III', 'IFI', 'SSS'], { I: 'iron_ingot', F: 'furnace', S: 'smooth_stone' });
sh(['furnace', 1], ['SSS', 'S S', 'SSS'], { S: '#stone_crafting_materials' });
sh(['brewing_stand', 1], [' B ', 'SSS'], { B: 'blaze_rod', S: '#stone_crafting_materials' });
sh(['cauldron', 1], ['I I', 'I I', 'III'], { I: 'iron_ingot' });
sh(['enchanting_table', 1], [' B ', 'DOD', 'OOO'], { B: 'book', D: 'diamond', O: 'obsidian' });
sh(['anvil', 1], ['BBB', ' I ', 'III'], { B: 'iron_block', I: 'iron_ingot' });
sh(['beacon', 1], ['GGG', 'GSG', 'OOO'], { G: 'glass', S: 'nether_star', O: 'obsidian' });
sh(['conduit', 1], ['NNN', 'NHN', 'NNN'], { N: 'nautilus_shell', H: 'heart_of_the_sea' });
sh(['lodestone', 1], ['SSS', 'SNS', 'SSS'], { S: 'chiseled_stone_bricks', N: 'netherite_ingot' });
sh(['respawn_anchor', 1], ['CCC', 'GGG', 'CCC'], { C: 'crying_obsidian', G: 'glowstone' });
sh(['bell', 1], [' P ', 'GGG', ' G '], { P: '#planks', G: 'gold_ingot' });
sh(['end_crystal', 1], ['GGG', 'GEG', 'GTG'], { G: 'glass', E: 'ender_eye', T: 'ghast_tear' });
sh(['armor_stand', 1], ['SSS', ' S ', 'SLS'], { S: 'stick', L: 'smooth_stone_slab' });
sh(['item_frame', 1], ['SSS', 'SLS', 'SSS'], { S: 'stick', L: 'leather' });
sl(['glow_item_frame', 1], ['item_frame', 'glow_ink_sac']);
sh(['painting', 1], ['SSS', 'SWS', 'SSS'], { S: 'stick', W: '#wool' });
sh(['flower_pot', 1], ['B B', ' B '], { B: 'brick' });
sh(['decorated_pot', 1], [' B ', 'B B', ' B '], { B: 'brick' });
sh(['target', 1], [' R ', 'RHR', ' R '], { R: 'redstone', H: 'hay_block' });
sh(['lightning_rod', 1], ['C', 'C', 'C'], { C: 'copper_ingot' });
sh(['sea_lantern', 1], ['SCS', 'CCC', 'SCS'], { S: 'prismarine_shard', C: 'prismarine_crystals' });
sh(['calibrated_sculk_sensor', 1], [' A ', 'ASA'], { A: 'amethyst_shard', S: 'sculk_sensor' });

// ===========================================================================
// 4. Stone families - stairs / slabs / walls
// ===========================================================================

// [base block, derived-name prefix (null = same), which shapes exist]
const STONE_FAMILIES = [
  ['cobblestone', null, 'slw'],
  ['mossy_cobblestone', null, 'slw'],
  ['stone', null, 'sl'],
  ['granite', null, 'slw'],
  ['polished_granite', null, 'sl'],
  ['diorite', null, 'slw'],
  ['polished_diorite', null, 'sl'],
  ['andesite', null, 'slw'],
  ['polished_andesite', null, 'sl'],
  ['stone_bricks', 'stone_brick', 'slw'],
  ['mossy_stone_bricks', 'mossy_stone_brick', 'slw'],
  ['sandstone', null, 'slw'],
  ['smooth_sandstone', null, 'sl'],
  ['red_sandstone', null, 'slw'],
  ['smooth_red_sandstone', null, 'sl'],
  ['bricks', 'brick', 'slw'],
  ['prismarine', null, 'slw'],
  ['prismarine_bricks', 'prismarine_brick', 'sl'],
  ['dark_prismarine', null, 'sl'],
  ['nether_bricks', 'nether_brick', 'slw'],
  ['red_nether_bricks', 'red_nether_brick', 'slw'],
  ['quartz_block', 'quartz', 'sl'],
  ['smooth_quartz', null, 'sl'],
  ['purpur_block', 'purpur', 'sl'],
  ['end_stone_bricks', 'end_stone_brick', 'slw'],
  ['blackstone', null, 'slw'],
  ['polished_blackstone', null, 'slw'],
  ['polished_blackstone_bricks', 'polished_blackstone_brick', 'slw'],
  ['cobbled_deepslate', null, 'slw'],
  ['polished_deepslate', null, 'slw'],
  ['deepslate_bricks', 'deepslate_brick', 'slw'],
  ['deepslate_tiles', 'deepslate_tile', 'slw'],
  ['mud_bricks', 'mud_brick', 'slw'],
];

for (const [base, override, flags] of STONE_FAMILIES) {
  const p = override || base;
  if (flags.includes('s')) sh([`${p}_stairs`, 4], ['X  ', 'XX ', 'XXX'], { X: base }, { group: 'stairs' });
  if (flags.includes('l')) sh([`${p}_slab`, 6], ['XXX'], { X: base }, { group: 'slab' });
  if (flags.includes('w')) sh([`${p}_wall`, 6], ['XXX', 'XXX'], { X: base }, { group: 'wall' });
}
sh(['smooth_stone_slab', 6], ['XXX'], { X: 'smooth_stone' }, { group: 'slab' });
sh(['cut_sandstone_slab', 6], ['XXX'], { X: 'cut_sandstone' }, { group: 'slab' });
sh(['cut_red_sandstone_slab', 6], ['XXX'], { X: 'cut_red_sandstone' }, { group: 'slab' });
sh(['nether_brick_fence', 6], ['NBN', 'NBN'], { N: 'nether_bricks', B: 'nether_brick' });

// --- base stone blocks ---
sh(['stone_bricks', 4], ['XX', 'XX'], { X: 'stone' });
sl(['mossy_cobblestone', 1], ['cobblestone', 'vine']);
sl(['mossy_cobblestone', 1], ['cobblestone', 'moss_block'], { id: 'mossy_cobblestone_from_moss' });
sl(['mossy_stone_bricks', 1], ['stone_bricks', 'vine']);
sl(['mossy_stone_bricks', 1], ['stone_bricks', 'moss_block'], { id: 'mossy_stone_bricks_from_moss' });
sh(['chiseled_stone_bricks', 1], ['S', 'S'], { S: 'stone_brick_slab' });
sh(['polished_granite', 4], ['XX', 'XX'], { X: 'granite' });
sh(['polished_diorite', 4], ['XX', 'XX'], { X: 'diorite' });
sh(['polished_andesite', 4], ['XX', 'XX'], { X: 'andesite' });
sh(['andesite', 2], ['DC'], { D: 'diorite', C: 'cobblestone' });
sh(['diorite', 2], ['QC', 'CQ'], { Q: 'quartz', C: 'cobblestone' });
sh(['granite', 1], ['DQ'], { D: 'diorite', Q: 'quartz' });
sh(['sandstone', 1], ['SS', 'SS'], { S: 'sand' });
sh(['cut_sandstone', 4], ['SS', 'SS'], { S: 'sandstone' });
sh(['chiseled_sandstone', 1], ['S', 'S'], { S: 'sandstone_slab' });
sh(['red_sandstone', 1], ['SS', 'SS'], { S: 'red_sand' });
sh(['cut_red_sandstone', 4], ['SS', 'SS'], { S: 'red_sandstone' });
sh(['chiseled_red_sandstone', 1], ['S', 'S'], { S: 'red_sandstone_slab' });
sh(['bricks', 1], ['BB', 'BB'], { B: 'brick' });
sh(['nether_bricks', 1], ['BB', 'BB'], { B: 'nether_brick' });
sh(['red_nether_bricks', 1], ['WN', 'NW'], { W: 'nether_wart', N: 'nether_brick' });
sh(['chiseled_nether_bricks', 1], ['S', 'S'], { S: 'nether_brick_slab' });
sh(['quartz_block', 1], ['QQ', 'QQ'], { Q: 'quartz' });
sh(['chiseled_quartz_block', 1], ['S', 'S'], { S: 'quartz_slab' });
sh(['quartz_pillar', 2], ['Q', 'Q'], { Q: 'quartz_block' });
sh(['quartz_bricks', 4], ['QQ', 'QQ'], { Q: 'quartz_block' });
sh(['prismarine', 1], ['SS', 'SS'], { S: 'prismarine_shard' });
sh(['prismarine_bricks', 1], ['SSS', 'SSS', 'SSS'], { S: 'prismarine_shard' });
sh(['dark_prismarine', 1], ['SSS', 'SDS', 'SSS'], { S: 'prismarine_shard', D: 'black_dye' });
sh(['purpur_block', 4], ['CC', 'CC'], { C: 'popped_chorus_fruit' });
sh(['purpur_pillar', 1], ['S', 'S'], { S: 'purpur_slab' });
sh(['end_stone_bricks', 4], ['EE', 'EE'], { E: 'end_stone' });
sh(['polished_blackstone', 4], ['BB', 'BB'], { B: 'blackstone' });
sh(['polished_blackstone_bricks', 4], ['BB', 'BB'], { B: 'polished_blackstone' });
sh(['chiseled_polished_blackstone', 1], ['S', 'S'], { S: 'polished_blackstone_slab' });
sh(['polished_basalt', 4], ['BB', 'BB'], { B: 'basalt' });
sh(['polished_deepslate', 4], ['DD', 'DD'], { D: 'cobbled_deepslate' });
sh(['deepslate_bricks', 4], ['DD', 'DD'], { D: 'polished_deepslate' });
sh(['deepslate_tiles', 4], ['DD', 'DD'], { D: 'deepslate_bricks' });
sh(['chiseled_deepslate', 1], ['S', 'S'], { S: 'cobbled_deepslate_slab' });
sh(['packed_mud', 1], ['MW'], { M: 'mud', W: 'wheat' });
sh(['mud_bricks', 4], ['MM', 'MM'], { M: 'packed_mud' });
sh(['coarse_dirt', 4], ['DG', 'GD'], { D: 'dirt', G: 'gravel' });
sh(['magma_block', 1], ['MM', 'MM'], { M: 'magma_cream' });
sh(['glowstone', 1], ['DD', 'DD'], { D: 'glowstone_dust' });
sh(['clay', 1], ['CC', 'CC'], { C: 'clay_ball' });
sh(['snow_block', 1], ['SS', 'SS'], { S: 'snowball' });
sh(['snow', 6], ['BBB'], { B: 'snow_block' });
sh(['packed_ice', 1], ['III', 'III', 'III'], { I: 'ice' });
sh(['blue_ice', 1], ['PPP', 'PPP', 'PPP'], { P: 'packed_ice' });
sh(['dripstone_block', 1], ['PP', 'PP'], { P: 'pointed_dripstone' });
sh(['moss_carpet', 3], ['MM'], { M: 'moss_block' });
sh(['amethyst_block', 1], ['AA', 'AA'], { A: 'amethyst_shard' });
sh(['tinted_glass', 2], [' A ', 'AGA', ' A '], { A: 'amethyst_shard', G: 'glass' });
sh(['glass_pane', 16], ['GGG', 'GGG'], { G: 'glass' });
sh(['iron_bars', 16], ['III', 'III'], { I: 'iron_ingot' });
sh(['chain', 1], ['N', 'I', 'N'], { N: 'iron_nugget', I: 'iron_ingot' });
sh(['lantern', 1], ['NNN', 'NTN', 'NNN'], { N: 'iron_nugget', T: 'torch' });
sh(['soul_lantern', 1], ['NNN', 'NTN', 'NNN'], { N: 'iron_nugget', T: 'soul_torch' });
sh(['end_rod', 4], ['B', 'P'], { B: 'blaze_rod', P: 'popped_chorus_fruit' });
sh(['jack_o_lantern', 1], ['P', 'T'], { P: 'carved_pumpkin', T: 'torch' });
sl(['muddy_mangrove_roots', 1], ['mangrove_roots', 'mud']);

// --- copper ---
const COPPER_STAGES = ['', 'exposed_', 'weathered_', 'oxidized_'];
for (const stage of COPPER_STAGES) {
  const block = stage ? `${stage}copper` : 'copper_block';
  const cut = `${stage}cut_copper`;
  sh([cut, 4], ['BB', 'BB'], { B: block }, { group: 'cut_copper' });
  sh([`${cut}_stairs`, 4], ['X  ', 'XX ', 'XXX'], { X: cut }, { group: 'stairs' });
  sh([`${cut}_slab`, 6], ['XXX'], { X: cut }, { group: 'slab' });
  const wblock = stage ? `waxed_${stage}copper` : 'waxed_copper_block';
  const wcut = `waxed_${stage}cut_copper`;
  sh([wcut, 4], ['BB', 'BB'], { B: wblock }, { group: 'cut_copper' });
  sh([`${wcut}_stairs`, 4], ['X  ', 'XX ', 'XXX'], { X: wcut }, { group: 'stairs' });
  sh([`${wcut}_slab`, 6], ['XXX'], { X: wcut }, { group: 'slab' });
  // Waxing with a honeycomb.
  sl([wblock, 1], [block, 'honeycomb'], { group: 'waxed_copper' });
  sl([wcut, 1], [cut, 'honeycomb'], { group: 'waxed_copper', id: `${wcut}_from_honeycomb` });
  sl([`${wcut}_stairs`, 1], [`${cut}_stairs`, 'honeycomb'], { group: 'waxed_copper' });
  sl([`${wcut}_slab`, 1], [`${cut}_slab`, 'honeycomb'], { group: 'waxed_copper' });
}

// ===========================================================================
// 5. Storage blocks, nuggets and mineral conversions
// ===========================================================================

// [block, unit, unit output count when unpacking]
const NINE_PACKS = [
  ['coal_block', 'coal'],
  ['iron_block', 'iron_ingot'],
  ['gold_block', 'gold_ingot'],
  ['diamond_block', 'diamond'],
  ['emerald_block', 'emerald'],
  ['lapis_block', 'lapis_lazuli'],
  ['redstone_block', 'redstone'],
  ['netherite_block', 'netherite_ingot'],
  ['copper_block', 'copper_ingot'],
  ['raw_iron_block', 'raw_iron'],
  ['raw_copper_block', 'raw_copper'],
  ['raw_gold_block', 'raw_gold'],
  ['slime_block', 'slimeball'],
  ['bone_block', 'bone_meal'],
  ['dried_kelp_block', 'dried_kelp'],
  ['hay_block', 'wheat'],
  ['nether_wart_block', 'nether_wart'],
  ['melon', 'melon_slice'],
];
for (const [block, unit] of NINE_PACKS) {
  if (block !== 'melon') sh([block, 1], ['XXX', 'XXX', 'XXX'], { X: unit }, { group: block });
  sl([unit, 9], [block], { group: unit, id: `${unit}_from_${block}` });
}
sh(['honeycomb_block', 1], ['HH', 'HH'], { H: 'honeycomb' });
sh(['melon', 1], ['MMM', 'MMM', 'MMM'], { M: 'melon_slice' });
sh(['iron_nugget', 9], ['I'], { I: 'iron_ingot' }, { id: 'iron_nugget_from_ingot' });
sh(['gold_nugget', 9], ['G'], { G: 'gold_ingot' }, { id: 'gold_nugget_from_ingot' });
sh(['iron_ingot', 1], ['NNN', 'NNN', 'NNN'], { N: 'iron_nugget' }, { id: 'iron_ingot_from_nuggets' });
sh(['gold_ingot', 1], ['NNN', 'NNN', 'NNN'], { N: 'gold_nugget' }, { id: 'gold_ingot_from_nuggets' });
sl(['netherite_ingot', 1], [...rep(4, 'netherite_scrap'), ...rep(4, 'gold_ingot')]);
sh(['honey_block', 1], ['HH', 'HH'], { H: 'honey_bottle' });
sh(['honey_bottle', 4], ['HH', 'HH'], { H: 'honey_block' }, { id: 'honey_bottle_from_block' });
sh(['sugar', 3], ['H'], { H: 'honey_bottle' }, { id: 'sugar_from_honey' });
sl(['bone_meal', 3], ['bone']);
sh(['music_disc_5', 1], ['FFF', 'FFF', 'FFF'], { F: 'disc_fragment_5' });

// ===========================================================================
// 6. Tools, weapons and armour
// ===========================================================================

const TOOL_MATERIALS = [
  ['wooden', '#planks'],
  ['stone', '#stone_tool_materials'],
  ['iron', 'iron_ingot'],
  ['golden', 'gold_ingot'],
  ['diamond', 'diamond'],
];
for (const [m, mat] of TOOL_MATERIALS) {
  sh(`${m}_sword`, ['M', 'M', 'S'], { M: mat, S: 'stick' }, { group: 'sword' });
  sh(`${m}_pickaxe`, ['MMM', ' S ', ' S '], { M: mat, S: 'stick' }, { group: 'pickaxe' });
  sh(`${m}_axe`, ['MM', 'MS', ' S'], { M: mat, S: 'stick' }, { group: 'axe' });
  sh(`${m}_shovel`, ['M', 'S', 'S'], { M: mat, S: 'stick' }, { group: 'shovel' });
  sh(`${m}_hoe`, ['MM', ' S', ' S'], { M: mat, S: 'stick' }, { group: 'hoe' });
}

const ARMOR_MATERIALS = [['leather', 'leather'], ['iron', 'iron_ingot'], ['golden', 'gold_ingot'], ['diamond', 'diamond']];
for (const [m, mat] of ARMOR_MATERIALS) {
  sh(`${m}_helmet`, ['MMM', 'M M'], { M: mat }, { group: 'helmet' });
  sh(`${m}_chestplate`, ['M M', 'MMM', 'MMM'], { M: mat }, { group: 'chestplate' });
  sh(`${m}_leggings`, ['MMM', 'M M', 'M M'], { M: mat }, { group: 'leggings' });
  sh(`${m}_boots`, ['M M', 'M M'], { M: mat }, { group: 'boots' });
}
sh('turtle_helmet', ['MMM', 'M M'], { M: 'turtle_scute' }, { group: 'helmet' });
sh('leather_horse_armor', ['L  ', 'LLL', 'L L'], { L: 'leather' });
sh('shield', ['PIP', 'PPP', ' P '], { P: '#planks', I: 'iron_ingot' });
sh('bow', [' SR', 'S R', ' SR'], { S: 'stick', R: 'string' });
sh('crossbow', ['SIS', 'RTR', ' S '], { S: 'stick', I: 'iron_ingot', R: 'string', T: 'tripwire_hook' });
sh(['arrow', 4], ['F', 'S', 'E'], { F: 'flint', S: 'stick', E: 'feather' });
sh(['spectral_arrow', 2], [' G ', 'GAG', ' G '], { G: 'glowstone_dust', A: 'arrow' });
sh('fishing_rod', ['  S', ' SR', 'S R'], { S: 'stick', R: 'string' });
sl('carrot_on_a_stick', ['fishing_rod', 'carrot']);
sl('warped_fungus_on_a_stick', ['fishing_rod', 'warped_fungus']);
sl('flint_and_steel', ['iron_ingot', 'flint']);
sh('shears', [' I', 'I '], { I: 'iron_ingot' });
sh('bucket', ['I I', ' I '], { I: 'iron_ingot' });
sh('compass', [' I ', 'IRI', ' I '], { I: 'iron_ingot', R: 'redstone' });
sh('recovery_compass', ['EEE', 'ECE', 'EEE'], { E: 'echo_shard', C: 'compass' });
sh('clock', [' G ', 'GRG', ' G '], { G: 'gold_ingot', R: 'redstone' });
sh('map', ['PPP', 'PCP', 'PPP'], { P: 'paper', C: 'compass' });
sh('spyglass', ['A', 'C', 'C'], { A: 'amethyst_shard', C: 'copper_ingot' });
sh('brush', ['F', 'C', 'S'], { F: 'feather', C: 'copper_ingot', S: 'stick' });
sh(['lead', 2], ['SS ', 'SB ', '  S'], { S: 'string', B: 'slimeball' });
sh('bundle', [' S ', 'HHH', 'HHH'], { S: 'string', H: 'rabbit_hide' });
sh(['leather', 1], ['HH', 'HH'], { H: 'rabbit_hide' });
sh(['wind_charge', 4], [' B ', 'B B', ' B '], { B: 'breeze_rod' });

// Netherite upgrades (smithing table).
for (const piece of ['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots']) {
  smithing('netherite_upgrade_smithing_template', `diamond_${piece}`, 'netherite_ingot', `netherite_${piece}`,
    { id: `netherite_${piece}_smithing` });
}

// Smithing template duplication: 1 template + 7 diamonds + 1 base block -> 2.
const TRIM_BASES = {
  coast: 'cobblestone', dune: 'sandstone', eye: 'end_stone', host: 'terracotta',
  raiser: 'terracotta', rib: 'netherrack', sentry: 'cobblestone', shaper: 'terracotta',
  silence: 'cobbled_deepslate', snout: 'blackstone', spire: 'purpur_block', tide: 'prismarine',
  vex: 'cobblestone', ward: 'cobbled_deepslate', wayfinder: 'terracotta', wild: 'mossy_cobblestone',
};
for (const [trim, base] of Object.entries(TRIM_BASES)) {
  const t = `${trim}_armor_trim_smithing_template`;
  sh([t, 2], ['DTD', 'DBD', 'DDD'], { D: 'diamond', T: t, B: base }, { group: 'trim_template' });
}
sh(['netherite_upgrade_smithing_template', 2], ['DTD', 'DBD', 'DDD'],
  { D: 'diamond', T: 'netherite_upgrade_smithing_template', B: 'netherrack' }, { group: 'trim_template' });

// ===========================================================================
// 7. Redstone, rails and transport
// ===========================================================================

sh(['torch', 4], ['C', 'S'], { C: '#coals', S: 'stick' });
sl(['soul_torch', 4], ['#coals', 'stick', '#soul_fire_base_blocks']);
sh('redstone_torch', ['R', 'S'], { R: 'redstone', S: 'stick' });
sh('lever', ['S', 'C'], { S: 'stick', C: 'cobblestone' });
sh('stone_button', ['S'], { S: 'stone' });
sh('polished_blackstone_button', ['S'], { S: 'polished_blackstone' });
sh('stone_pressure_plate', ['SS'], { S: 'stone' });
sh('polished_blackstone_pressure_plate', ['SS'], { S: 'polished_blackstone' });
sh('light_weighted_pressure_plate', ['GG'], { G: 'gold_ingot' });
sh('heavy_weighted_pressure_plate', ['II'], { I: 'iron_ingot' });
sh(['tripwire_hook', 2], ['I', 'S', 'P'], { I: 'iron_ingot', S: 'stick', P: '#planks' });
sh('repeater', ['TRT', 'SSS'], { T: 'redstone_torch', R: 'redstone', S: 'stone' });
sh('comparator', [' T ', 'TQT', 'SSS'], { T: 'redstone_torch', Q: 'quartz', S: 'stone' });
sh('observer', ['CCC', 'RRQ', 'CCC'], { C: 'cobblestone', R: 'redstone', Q: 'quartz' });
sh('daylight_detector', ['GGG', 'QQQ', 'SSS'], { G: 'glass', Q: 'quartz', S: '#wooden_slabs' });
sh('redstone_lamp', [' R ', 'RGR', ' R '], { R: 'redstone', G: 'glowstone' });
sh('piston', ['PPP', 'CIC', 'CRC'], { P: '#planks', C: 'cobblestone', I: 'iron_ingot', R: 'redstone' });
sl('sticky_piston', ['piston', 'slimeball']);
sh('dispenser', ['CCC', 'CBC', 'CRC'], { C: 'cobblestone', B: 'bow', R: 'redstone' });
sh('dropper', ['CCC', 'C C', 'CRC'], { C: 'cobblestone', R: 'redstone' });
sh('hopper', ['I I', 'ICI', ' I '], { I: 'iron_ingot', C: 'chest' });
sh('iron_door', ['II', 'II', 'II'], { I: 'iron_ingot' });
sh(['iron_trapdoor', 1], ['II', 'II'], { I: 'iron_ingot' });
sh(['tnt', 1], ['GSG', 'SGS', 'GSG'], { G: 'gunpowder', S: '#sand' });
sh(['rail', 16], ['I I', 'ISI', 'I I'], { I: 'iron_ingot', S: 'stick' });
sh(['powered_rail', 6], ['G G', 'GSG', 'GRG'], { G: 'gold_ingot', S: 'stick', R: 'redstone' });
sh(['detector_rail', 6], ['I I', 'IPI', 'IRI'], { I: 'iron_ingot', P: 'stone_pressure_plate', R: 'redstone' });
sh(['activator_rail', 6], ['ISI', 'IRI', 'ISI'], { I: 'iron_ingot', S: 'stick', R: 'redstone_torch' });
sh('minecart', ['I I', 'III'], { I: 'iron_ingot' });
sl('chest_minecart', ['chest', 'minecart']);
sl('furnace_minecart', ['furnace', 'minecart']);
sl('hopper_minecart', ['hopper', 'minecart']);
sl('tnt_minecart', ['tnt', 'minecart']);
sl('shulker_box', ['shulker_shell', 'chest', 'shulker_shell']);

// ===========================================================================
// 8. Food and farming
// ===========================================================================

sh(['bread', 1], ['WWW'], { W: 'wheat' });
sh(['cookie', 8], ['WCW'], { W: 'wheat', C: 'cocoa_beans' });
sh('cake', ['MMM', 'SES', 'WWW'], { M: 'milk_bucket', S: 'sugar', E: 'egg', W: 'wheat' });
sh('pumpkin_pie', ['   ', 'PSE', '   '], { P: 'pumpkin', S: 'sugar', E: 'egg' });
sl('pumpkin_pie', ['pumpkin', 'sugar', 'egg'], { id: 'pumpkin_pie_shapeless' });
sl('mushroom_stew', ['brown_mushroom', 'red_mushroom', 'bowl']);
sl('beetroot_soup', [...rep(6, 'beetroot'), 'bowl']);
sl('rabbit_stew', ['cooked_rabbit', 'carrot', 'baked_potato', 'brown_mushroom', 'bowl']);
sl('rabbit_stew', ['cooked_rabbit', 'carrot', 'baked_potato', 'red_mushroom', 'bowl'],
  { id: 'rabbit_stew_red' });
sh('golden_apple', ['GGG', 'GAG', 'GGG'], { G: 'gold_ingot', A: 'apple' });
sh('golden_carrot', ['NNN', 'NCN', 'NNN'], { N: 'gold_nugget', C: 'carrot' });
sh('glistering_melon_slice', ['NNN', 'NMN', 'NNN'], { N: 'gold_nugget', M: 'melon_slice' });
sh(['sugar', 1], ['C'], { C: 'sugar_cane' });
sh(['paper', 3], ['CCC'], { C: 'sugar_cane' });
sl('book', ['paper', 'paper', 'paper', 'leather']);
sl('writable_book', ['book', 'ink_sac', 'feather']);
sh(['pumpkin_seeds', 4], ['P'], { P: 'pumpkin' });
sh(['melon_seeds', 1], ['M'], { M: 'melon_slice' });
sh(['blaze_powder', 2], ['B'], { B: 'blaze_rod' });
sl('magma_cream', ['blaze_powder', 'slimeball']);
sl('fermented_spider_eye', ['spider_eye', 'sugar', 'brown_mushroom']);
sl('ender_eye', ['ender_pearl', 'blaze_powder']);
sh(['fire_charge', 3], ['BCG'], { B: 'blaze_powder', C: '#coals', G: 'gunpowder' });
sh(['glass_bottle', 3], ['G G', ' G '], { G: 'glass' });

// ===========================================================================
// 9. Dyes and the 16-colour families
// ===========================================================================

sl('white_dye', ['bone_meal']);
sl('white_dye', ['lily_of_the_valley'], { id: 'white_dye_from_flower' });
sl('black_dye', ['ink_sac']);
sl('black_dye', ['wither_rose'], { id: 'black_dye_from_flower' });
sl('blue_dye', ['lapis_lazuli']);
sl('blue_dye', ['cornflower'], { id: 'blue_dye_from_flower' });
sl('brown_dye', ['cocoa_beans']);
sl('red_dye', ['poppy']);
sl('red_dye', ['red_tulip'], { id: 'red_dye_from_tulip' });
sl('red_dye', ['beetroot'], { id: 'red_dye_from_beetroot' });
sl(['red_dye', 2], ['rose_bush'], { id: 'red_dye_from_rose_bush' });
sl('yellow_dye', ['dandelion']);
sl(['yellow_dye', 2], ['sunflower'], { id: 'yellow_dye_from_sunflower' });
sl('orange_dye', ['orange_tulip']);
sl(['orange_dye', 2], ['red_dye', 'yellow_dye'], { id: 'orange_dye_mix' });
sl('light_blue_dye', ['blue_orchid']);
sl(['light_blue_dye', 2], ['blue_dye', 'white_dye'], { id: 'light_blue_dye_mix' });
sl('magenta_dye', ['allium']);
sl(['magenta_dye', 2], ['lilac'], { id: 'magenta_dye_from_lilac' });
sl(['magenta_dye', 2], ['purple_dye', 'pink_dye'], { id: 'magenta_dye_mix' });
sl(['magenta_dye', 4], ['blue_dye', 'red_dye', 'pink_dye', 'white_dye'], { id: 'magenta_dye_mix4' });
sl('pink_dye', ['pink_tulip']);
sl(['pink_dye', 2], ['peony'], { id: 'pink_dye_from_peony' });
sl(['pink_dye', 2], ['red_dye', 'white_dye'], { id: 'pink_dye_mix' });
sl('light_gray_dye', ['azure_bluet']);
sl('light_gray_dye', ['oxeye_daisy'], { id: 'light_gray_dye_from_daisy' });
sl('light_gray_dye', ['white_tulip'], { id: 'light_gray_dye_from_tulip' });
sl(['light_gray_dye', 2], ['gray_dye', 'white_dye'], { id: 'light_gray_dye_mix' });
sl(['light_gray_dye', 3], ['black_dye', 'white_dye', 'white_dye'], { id: 'light_gray_dye_mix3' });
sl(['gray_dye', 2], ['black_dye', 'white_dye']);
sl(['lime_dye', 2], ['green_dye', 'white_dye']);
sl(['cyan_dye', 2], ['blue_dye', 'green_dye']);
sl(['purple_dye', 2], ['blue_dye', 'red_dye']);

sh(['white_wool', 1], ['SS', 'SS'], { S: 'string' }, { id: 'white_wool_from_string' });
for (let i = 0; i < COLORS.length; i++) {
  const c = COLORS[i];
  const dye = `${c}_dye`;
  sl([`${c}_wool`, 1], ['#wool', dye], { group: 'wool' });
  sh([`${c}_carpet`, 3], ['WW'], { W: `${c}_wool` }, { group: 'carpet' });
  sh([`${c}_carpet`, 8], ['CCC', 'CDC', 'CCC'], { C: 'white_carpet', D: dye }, { group: 'carpet', id: `${c}_carpet_from_dye` });
  sl([`${c}_concrete_powder`, 8], [...rep(4, '#sand'), ...rep(4, 'gravel'), dye], { group: 'concrete_powder' });
  sh([`${c}_stained_glass`, 8], ['GGG', 'GDG', 'GGG'], { G: 'glass', D: dye }, { group: 'stained_glass' });
  sh([`${c}_stained_glass_pane`, 16], ['GGG', 'GGG'], { G: `${c}_stained_glass` }, { group: 'stained_glass_pane' });
  sh([`${c}_stained_glass_pane`, 8], ['PPP', 'PDP', 'PPP'], { P: 'glass_pane', D: dye }, { group: 'stained_glass_pane', id: `${c}_stained_glass_pane_from_dye` });
  sh([`${c}_terracotta`, 8], ['TTT', 'TDT', 'TTT'], { T: 'terracotta', D: dye }, { group: 'stained_terracotta' });
  sh([`${c}_bed`, 1], ['WWW', 'PPP'], { W: `${c}_wool`, P: '#planks' }, { group: 'bed' });
  sl([`${c}_bed`, 1], ['#beds', dye], { group: 'bed', id: `${c}_bed_from_dye` });
  sh([`${c}_banner`, 1], ['WWW', 'WWW', ' S '], { W: `${c}_wool`, S: 'stick' }, { group: 'banner' });
  sl([`${c}_candle`, 1], ['candle', dye], { group: 'candle' });
}
sl('candle', ['string', 'honeycomb']);

// ===========================================================================
// 10. Stonecutting (used by the stonecutter screen)
// ===========================================================================

/** input item name -> [{ output, count }] */
export const STONECUTTING = new Map();
function cut(input, output, count = 1) {
  if (input === output) return;
  let l = STONECUTTING.get(input);
  if (!l) STONECUTTING.set(input, (l = []));
  if (!l.some((e) => e.output === output)) l.push({ output, count });
}
for (const [base, override, flags] of STONE_FAMILIES) {
  const p = override || base;
  if (flags.includes('s')) cut(base, `${p}_stairs`, 1);
  if (flags.includes('l')) cut(base, `${p}_slab`, 2);
  if (flags.includes('w')) cut(base, `${p}_wall`, 1);
}
cut('stone', 'stone_bricks', 1);
cut('stone', 'smooth_stone', 1);
cut('stone_bricks', 'chiseled_stone_bricks', 1);
cut('sandstone', 'cut_sandstone', 1);
cut('sandstone', 'chiseled_sandstone', 1);
cut('red_sandstone', 'cut_red_sandstone', 1);
cut('red_sandstone', 'chiseled_red_sandstone', 1);
cut('quartz_block', 'quartz_pillar', 1);
cut('quartz_block', 'quartz_bricks', 1);
cut('quartz_block', 'chiseled_quartz_block', 1);
cut('purpur_block', 'purpur_pillar', 1);
cut('nether_bricks', 'chiseled_nether_bricks', 1);
cut('polished_blackstone', 'polished_blackstone_bricks', 1);
cut('polished_blackstone', 'chiseled_polished_blackstone', 1);
cut('cobbled_deepslate', 'polished_deepslate', 1);
cut('cobbled_deepslate', 'deepslate_bricks', 1);
cut('cobbled_deepslate', 'deepslate_tiles', 1);
cut('cobbled_deepslate', 'chiseled_deepslate', 1);
cut('polished_deepslate', 'deepslate_bricks', 1);
cut('deepslate_bricks', 'deepslate_tiles', 1);
cut('prismarine', 'prismarine_bricks', 1);
cut('copper_block', 'cut_copper', 4);
cut('exposed_copper', 'exposed_cut_copper', 4);
cut('weathered_copper', 'weathered_cut_copper', 4);
cut('oxidized_copper', 'oxidized_cut_copper', 4);
cut('smooth_stone', 'smooth_stone_slab', 2);
cut('cut_sandstone', 'cut_sandstone_slab', 2);
cut('cut_red_sandstone', 'cut_red_sandstone_slab', 2);

/** Everything a stonecutter can make from this item. */
export function stonecuttingFor(itemName) {
  return STONECUTTING.get(itemName) || [];
}

// ===========================================================================
// 11. Special (dynamic) recipes
// ===========================================================================

const CONTAINER_REMAINS = {
  water_bucket: 'bucket', lava_bucket: 'bucket', milk_bucket: 'bucket', powder_snow_bucket: 'bucket',
  cod_bucket: 'bucket', salmon_bucket: 'bucket', tropical_fish_bucket: 'bucket',
  pufferfish_bucket: 'bucket', axolotl_bucket: 'bucket', tadpole_bucket: 'bucket',
  honey_bottle: 'glass_bottle', dragon_breath: 'glass_bottle', experience_bottle: 'glass_bottle',
  mushroom_stew: 'bowl', rabbit_stew: 'bowl', beetroot_soup: 'bowl', suspicious_stew: 'bowl',
};

const DYE_INDEX = new Map();
for (let i = 0; i < COLORS.length; i++) DYE_INDEX.set(`${COLORS[i]}_dye`, i);

const isDyeItem = (n) => DYE_INDEX.has(n);
const dyeColorHex = (n) => DYE_HEX[DYE_INDEX.get(n) || 0];
const dyeColorName = (n) => COLORS[DYE_INDEX.get(n) || 0];

/** Flower -> [effect, ticks, level] carried by a suspicious stew. */
const STEW_EFFECTS = {
  allium: ['fire_resistance', 80, 0],
  azure_bluet: ['blindness', 160, 0],
  blue_orchid: ['saturation', 7, 0],
  dandelion: ['saturation', 7, 0],
  cornflower: ['jump_boost', 120, 0],
  lily_of_the_valley: ['poison', 240, 0],
  oxeye_daisy: ['regeneration', 160, 0],
  poppy: ['night_vision', 100, 0],
  torchflower: ['night_vision', 100, 0],
  red_tulip: ['weakness', 180, 0],
  orange_tulip: ['weakness', 180, 0],
  white_tulip: ['weakness', 180, 0],
  pink_tulip: ['weakness', 180, 0],
  wither_rose: ['wither', 160, 0],
};

/** 3x3 dye masks -> banner pattern id. '#' marks a dye, ' ' anything else. */
const BANNER_MASKS = {
  '      ###': 'stripe_bottom',
  '###      ': 'stripe_top',
  '#  #  #  ': 'stripe_left',
  '  #  #  #': 'stripe_right',
  ' #  #  # ': 'stripe_center',
  '   ###   ': 'stripe_middle',
  '#   #   #': 'stripe_downright',
  '  # # #  ': 'stripe_downleft',
  '# # # # #': 'cross',
  ' # ### # ': 'straight_cross',
  '######   ': 'half_horizontal',
  '   ######': 'half_horizontal_bottom',
  '## ## ## ': 'half_vertical',
  ' ## ## ##': 'half_vertical_right',
  '#        ': 'square_top_left',
  '  #      ': 'square_top_right',
  '      #  ': 'square_bottom_left',
  '        #': 'square_bottom_right',
  '    # # #': 'triangle_bottom',
  '# # #    ': 'triangle_top',
  '### # ###': 'border',
  ' # # # # ': 'rhombus',
  '# # # ###': 'gradient',
  '### # # #': 'gradient_up',
};

/** Banner-pattern items that stamp a fixed motif. */
const PATTERN_ITEMS = {
  creeper_banner_pattern: 'creeper',
  skull_banner_pattern: 'skull',
  flower_banner_pattern: 'flower',
  mojang_banner_pattern: 'mojang',
  globe_banner_pattern: 'globe',
  piglin_banner_pattern: 'piglin',
  flow_banner_pattern: 'flow',
  guster_banner_pattern: 'guster',
};

const isBanner = (n) => n.endsWith('_banner');
const isShulkerBox = (n) => n === 'shulker_box' || n.endsWith('_shulker_box');

/** Makes a bare stack. Kept local so recipes.js never imports inventory.js. */
function mk(item, count = 1, extra = null) {
  const s = { item, count, damage: 0 };
  if (extra) Object.assign(s, extra);
  return s;
}

/** Averages dye colours the way vanilla does for leather armour. */
function mixColors(baseColor, dyeNames) {
  let r = 0, g = 0, b = 0, maxSum = 0, n = 0;
  const add = (hex) => {
    const cr = (hex >> 16) & 255, cg = (hex >> 8) & 255, cb = hex & 255;
    r += cr; g += cg; b += cb;
    maxSum += Math.max(cr, cg, cb);
    n++;
  };
  if (baseColor !== null && baseColor !== undefined) add(baseColor);
  for (const d of dyeNames) add(dyeColorHex(d));
  if (!n) return baseColor || 0xa06540;
  const avgMax = maxSum / n;
  r /= n; g /= n; b /= n;
  const peak = Math.max(r, g, b) || 1;
  const gain = avgMax / peak;
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * gain)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
}

/** Builds a 9-char mask of the grid, anchored top-left in a 3x3 frame. */
function maskOf(grid, w, h, pred) {
  const cells = ['   ', '   ', '   '].join('').split('');
  for (let y = 0; y < Math.min(h, 3); y++) {
    for (let x = 0; x < Math.min(w, 3); x++) {
      const s = grid[y * w + x];
      if (s && s.item && pred(s)) cells[y * 3 + x] = '#';
    }
  }
  return cells.join('');
}

// --- individual special handlers -------------------------------------------

/** Two damaged items of the same kind fuse, restoring durability plus 5%. */
function specialRepair(stacks) {
  if (stacks.length !== 2) return null;
  const [a, b] = stacks;
  if (a.item !== b.item) return null;
  if ((a.count || 1) !== 1 || (b.count || 1) !== 1) return null;
  const def = getItem(a.item);
  const max = def.durability | 0;
  if (max <= 0) return null;
  const left = (max - (a.damage || 0)) + (max - (b.damage || 0)) + Math.floor(max * 0.05);
  const damage = Math.max(0, max - left);
  return mk(a.item, 1, { damage });
}

/** A blank banner next to a decorated one of the same colour copies it. */
function specialBannerDuplicate(stacks) {
  if (stacks.length !== 2) return null;
  const [a, b] = stacks;
  if (a.item !== b.item || !isBanner(a.item)) return null;
  const pa = a.patterns && a.patterns.length ? a : null;
  const pb = b.patterns && b.patterns.length ? b : null;
  if (!!pa === !!pb) return null;          // both blank or both decorated
  const src = pa || pb;
  return mk(src.item, 1, { patterns: src.patterns.map((p) => ({ ...p })) });
}

/** Adds one pattern layer to a banner from a dye layout or a pattern item. */
function specialBannerPattern(stacks, grid, w, h) {
  let banner = null, patternItem = null, extra = null;
  const dyes = [];
  for (const s of stacks) {
    if (isBanner(s.item)) {
      if (banner) return null;
      banner = s;
    } else if (PATTERN_ITEMS[s.item]) {
      if (patternItem) return null;
      patternItem = s;
    } else if (isDyeItem(s.item)) {
      dyes.push(s);
    } else if (s.item === 'vine' || s.item === 'bricks') {
      if (extra) return null;
      extra = s;
    } else return null;
  }
  if (!banner || dyes.length === 0) return null;
  if ((banner.patterns || []).length >= 6) return null;
  const color = dyeColorName(dyes[0].item);
  for (const d of dyes) if (dyeColorName(d.item) !== color) return null;

  let pattern = null;
  if (patternItem) {
    if (dyes.length !== 1) return null;
    pattern = PATTERN_ITEMS[patternItem.item];
  } else if (extra) {
    if (dyes.length !== 1) return null;
    pattern = extra.item === 'vine' ? 'curly_border' : 'bricks';
  } else {
    pattern = BANNER_MASKS[maskOf(grid, w, h, (s) => isDyeItem(s.item))] || null;
  }
  if (!pattern) return null;
  const patterns = (banner.patterns || []).map((p) => ({ ...p }));
  patterns.push({ pattern, color });
  return mk(banner.item, 1, { patterns });
}

/** A banner applied to a plain shield copies its colours onto the shield. */
function specialShieldPattern(stacks) {
  if (stacks.length !== 2) return null;
  let shield = null, banner = null;
  for (const s of stacks) {
    if (s.item === 'shield') shield = s;
    else if (isBanner(s.item)) banner = s;
    else return null;
  }
  if (!shield || !banner) return null;
  if (shield.patterns && shield.patterns.length) return null;
  return mk('shield', 1, {
    damage: shield.damage || 0,
    baseColor: banner.item.slice(0, -7),
    patterns: (banner.patterns || []).map((p) => ({ ...p })),
    enchants: shield.enchants ? { ...shield.enchants } : undefined,
  });
}

/** Paper + 1-3 gunpowder (+ up to 7 stars) -> 3 rockets; powder sets flight. */
function specialFireworkRocket(stacks) {
  let paper = 0, powder = 0;
  const stars = [];
  for (const s of stacks) {
    if (s.item === 'paper') paper++;
    else if (s.item === 'gunpowder') powder++;
    else if (s.item === 'firework_star') stars.push(s);
    else return null;
  }
  if (paper !== 1 || powder < 1 || powder > 3 || stars.length > 7) return null;
  const colors = [];
  const explosions = [];
  for (const st of stars) {
    explosions.push({
      shape: st.shape || 'small_ball',
      colors: st.colors ? st.colors.slice() : [0xffffff],
      fadeColors: st.fadeColors ? st.fadeColors.slice() : [],
      trail: !!st.trail, twinkle: !!st.twinkle,
    });
    for (const c of (st.colors || [])) colors.push(c);
  }
  return mk('firework_rocket', 3, {
    flightDuration: powder,
    explosions,
    colors: colors.length ? colors : null,
  });
}

const FIREWORK_SHAPES = {
  fire_charge: 'large_ball',
  gold_nugget: 'star',
  feather: 'burst',
  creeper_head: 'creeper',
  skeleton_skull: 'creeper',
  wither_skeleton_skull: 'creeper',
  zombie_head: 'creeper',
  player_head: 'creeper',
  dragon_head: 'creeper',
  piglin_head: 'creeper',
};

/** Gunpowder + dyes (+ shape/modifier items) -> a firework star. */
function specialFireworkStar(stacks) {
  let powder = 0, shape = null, trail = false, twinkle = false;
  const dyes = [];
  for (const s of stacks) {
    if (s.item === 'gunpowder') powder++;
    else if (isDyeItem(s.item)) dyes.push(s.item);
    else if (FIREWORK_SHAPES[s.item]) { if (shape) return null; shape = FIREWORK_SHAPES[s.item]; }
    else if (s.item === 'diamond') trail = true;
    else if (s.item === 'glowstone_dust') twinkle = true;
    else return null;
  }
  if (powder !== 1 || dyes.length < 1) return null;
  return mk('firework_star', 1, {
    shape: shape || 'small_ball',
    colors: dyes.map(dyeColorHex),
    fadeColors: [],
    trail, twinkle,
  });
}

/** An existing star plus dyes gains fade colours. */
function specialFireworkStarFade(stacks) {
  let star = null;
  const dyes = [];
  for (const s of stacks) {
    if (s.item === 'firework_star') { if (star) return null; star = s; }
    else if (isDyeItem(s.item)) dyes.push(s.item);
    else return null;
  }
  if (!star || !dyes.length) return null;
  if (star.fadeColors && star.fadeColors.length) return null;
  return mk('firework_star', 1, {
    shape: star.shape || 'small_ball',
    colors: star.colors ? star.colors.slice() : [0xffffff],
    fadeColors: dyes.map(dyeColorHex),
    trail: !!star.trail, twinkle: !!star.twinkle,
  });
}

/** Filled map + blank maps -> that many extra copies. */
function specialMapClone(stacks) {
  let filled = null, blanks = 0;
  for (const s of stacks) {
    if (s.item === 'filled_map') { if (filled) return null; filled = s; }
    else if (s.item === 'map') blanks++;
    else return null;
  }
  if (!filled || blanks < 1) return null;
  return mk('filled_map', blanks + 1, {
    mapId: filled.mapId !== undefined ? filled.mapId : 0,
    scale: filled.scale || 0,
    mapCenterX: filled.mapCenterX || 0,
    mapCenterZ: filled.mapCenterZ || 0,
    locked: !!filled.locked,
  });
}

/** 8 paper around a filled map zooms it out one level. */
function specialMapExtend(stacks) {
  let filled = null, paper = 0, panes = 0;
  for (const s of stacks) {
    if (s.item === 'filled_map') { if (filled) return null; filled = s; }
    else if (s.item === 'paper') paper++;
    else if (s.item === 'glass_pane') panes++;
    else return null;
  }
  if (!filled) return null;
  if (paper === 8 && panes === 0) {
    const scale = filled.scale || 0;
    if (scale >= 4) return null;
    return mk('filled_map', 1, {
      mapId: filled.mapId !== undefined ? filled.mapId : 0,
      scale: scale + 1,
      mapCenterX: filled.mapCenterX || 0,
      mapCenterZ: filled.mapCenterZ || 0,
      locked: !!filled.locked,
    });
  }
  if (panes === 8 && paper === 0) {
    if (filled.locked) return null;
    return mk('filled_map', 1, {
      mapId: filled.mapId !== undefined ? filled.mapId : 0,
      scale: filled.scale || 0,
      mapCenterX: filled.mapCenterX || 0,
      mapCenterZ: filled.mapCenterZ || 0,
      locked: true,
    });
  }
  return null;
}

/** A written book plus blank books produces that many copies. */
function specialBookCopy(stacks) {
  let src = null, blanks = 0;
  for (const s of stacks) {
    if (s.item === 'written_book') { if (src) return null; src = s; }
    else if (s.item === 'writable_book') blanks++;
    else return null;
  }
  if (!src || blanks < 1) return null;
  const gen = (src.generation || 0) + 1;
  if (gen > 2) return null;              // copies of a copy cannot be copied
  return mk('written_book', blanks, {
    title: src.title || 'Book',
    author: src.author || '',
    pages: src.pages ? src.pages.slice() : [],
    generation: gen,
  });
}

const DYEABLE_LEATHER = new Set(TAGS['#leather_armor']);

/** Leather armour absorbs 1-8 dyes and averages their colour. */
function specialLeatherDye(stacks) {
  let armor = null;
  const dyes = [];
  for (const s of stacks) {
    if (DYEABLE_LEATHER.has(s.item)) { if (armor) return null; armor = s; }
    else if (isDyeItem(s.item)) dyes.push(s.item);
    else return null;
  }
  if (!armor || !dyes.length) return null;
  const out = mk(armor.item, 1, {
    damage: armor.damage || 0,
    color: mixColors(armor.color !== undefined && armor.color !== null ? armor.color : null, dyes),
  });
  if (armor.enchants) out.enchants = { ...armor.enchants };
  return out;
}

/** Any shulker box plus one dye becomes that colour, keeping its contents. */
function specialShulkerDye(stacks) {
  if (stacks.length !== 2) return null;
  let box = null, dye = null;
  for (const s of stacks) {
    if (isShulkerBox(s.item)) box = s;
    else if (isDyeItem(s.item)) dye = s.item;
    else return null;
  }
  if (!box || !dye) return null;
  const name = `${dyeColorName(dye)}_shulker_box`;
  if (name === box.item) return null;
  const out = mk(name, 1);
  if (box.items) out.items = box.items;
  if (box.customName) out.customName = box.customName;
  return out;
}

/** Bowl + both mushrooms + any flower -> a stew carrying that flower's effect. */
function specialSuspiciousStew(stacks) {
  if (stacks.length !== 4) return null;
  let bowl = 0, brown = 0, red = 0, flower = null;
  for (const s of stacks) {
    if (s.item === 'bowl') bowl++;
    else if (s.item === 'brown_mushroom') brown++;
    else if (s.item === 'red_mushroom') red++;
    else if (STEW_EFFECTS[s.item]) flower = s.item;
    else return null;
  }
  if (bowl !== 1 || brown !== 1 || red !== 1 || !flower) return null;
  const eff = STEW_EFFECTS[flower];
  return mk('suspicious_stew', 1, {
    stewEffect: eff[0],
    effects: [[eff[0], eff[1], eff[2]]],
    flower,
  });
}

/** 8 arrows around a lingering potion become 8 tipped arrows. */
function specialTippedArrow(stacks, grid, w, h) {
  if (w !== 3 || h !== 3) return null;
  const centre = grid[4];
  if (!centre || !centre.item || !centre.item.startsWith('lingering_potion')) return null;
  for (let i = 0; i < 9; i++) {
    if (i === 4) continue;
    const s = grid[i];
    if (!s || s.item !== 'arrow') return null;
  }
  const suffix = centre.item === 'lingering_potion' ? '' : centre.item.slice('lingering_potion_'.length);
  const name = suffix && itemExists(`tipped_arrow_${suffix}`) ? `tipped_arrow_${suffix}` : 'tipped_arrow';
  return mk(name, 8, { potion: suffix || centre.potion || null });
}

const SPECIALS = [
  { id: 'special_banner_duplicate', fn: specialBannerDuplicate },
  { id: 'special_shield_pattern', fn: specialShieldPattern },
  { id: 'special_banner_pattern', fn: specialBannerPattern },
  { id: 'special_firework_rocket', fn: specialFireworkRocket },
  { id: 'special_firework_star', fn: specialFireworkStar },
  { id: 'special_firework_star_fade', fn: specialFireworkStarFade },
  { id: 'special_map_clone', fn: specialMapClone },
  { id: 'special_map_extend', fn: specialMapExtend },
  { id: 'special_book_copy', fn: specialBookCopy },
  { id: 'special_leather_dye', fn: specialLeatherDye },
  { id: 'special_shulker_dye', fn: specialShulkerDye },
  { id: 'special_suspicious_stew', fn: specialSuspiciousStew },
  { id: 'special_tipped_arrow', fn: specialTippedArrow },
  { id: 'special_repair', fn: specialRepair },
];

// ===========================================================================
// 12. Grid matching
// ===========================================================================

/** Trims empty rows/columns off a crafting grid. */
function trimGrid(grid, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = grid[y * w + x];
      if (!s || !s.item || (s.count !== undefined && s.count <= 0)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const tw = x1 - x0 + 1, th = y1 - y0 + 1;
  const cells = new Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const s = grid[(y + y0) * w + (x + x0)];
      cells[y * tw + x] = (s && s.item && (s.count === undefined || s.count > 0)) ? s : null;
    }
  }
  return { w: tw, h: th, cells };
}

function shapedMatches(r, cells, w, h, mirrored) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ing = r.cells[y * w + (mirrored ? w - 1 - x : x)];
      const s = cells[y * w + x];
      if (!ing) { if (s) return false; }
      else if (!matchesIngredient(ing, s)) return false;
    }
  }
  return true;
}

/** Backtracking multiset match for shapeless recipes (grids are tiny). */
function shapelessMatches(ings, stacks) {
  const n = ings.length;
  if (n !== stacks.length) return false;
  const used = new Array(n).fill(false);
  const walk = (i) => {
    if (i === n) return true;
    const s = stacks[i];
    for (let j = 0; j < n; j++) {
      if (used[j] || !matchesIngredient(ings[j], s)) continue;
      used[j] = true;
      if (walk(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return walk(0);
}

/**
 * Finds the recipe a crafting grid satisfies.
 * Returns `{ recipe, output }` or null. `recipe` is null for special recipes,
 * whose id is then found on `output.recipeId`.
 */
export function findRecipe(grid, width, height) {
  const w = width || Math.round(Math.sqrt(grid.length)) || 1;
  const h = height || Math.ceil(grid.length / w);
  const trimmed = trimGrid(grid, w, h);
  if (!trimmed) return null;

  const stacks = trimmed.cells.filter(Boolean);

  // Shaped: only recipes with exactly the trimmed footprint can match.
  const sized = SHAPED_BY_SIZE.get(trimmed.w + 'x' + trimmed.h);
  if (sized) {
    for (let i = 0; i < sized.length; i++) {
      const r = sized[i];
      if (shapedMatches(r, trimmed.cells, trimmed.w, trimmed.h, false)) {
        return { recipe: r, output: outputStack(r) };
      }
      if (r.mirror && r.w > 1 && shapedMatches(r, trimmed.cells, trimmed.w, trimmed.h, true)) {
        return { recipe: r, output: outputStack(r) };
      }
    }
  }

  // Shapeless.
  const bucket = SHAPELESS_BY_COUNT.get(stacks.length);
  if (bucket) {
    for (let i = 0; i < bucket.length; i++) {
      const r = bucket[i];
      if (shapelessMatches(r.ingredients, stacks)) return { recipe: r, output: outputStack(r) };
    }
  }

  // Dynamic recipes last: nothing static can describe their output.
  for (let i = 0; i < SPECIALS.length; i++) {
    const out = SPECIALS[i].fn(stacks, grid, w, h);
    if (out) {
      out.recipeId = SPECIALS[i].id;
      return { recipe: null, output: out, special: SPECIALS[i].id };
    }
  }
  return null;
}

/** A fresh copy of a recipe's result. */
function outputStack(r) {
  const o = r.output;
  const s = { item: o.item, count: o.count, damage: 0 };
  for (const k in o) {
    if (k === 'item' || k === 'count') continue;
    const v = o[k];
    s[k] = Array.isArray(v) ? v.slice() : v;
  }
  s.recipeId = r.id;
  return s;
}

/**
 * Matches a crafting grid. `grid` is an array of stacks (or nulls) laid out
 * row-major in a `width` x `height` frame. Returns a fresh output stack or null.
 */
export function matchRecipe(grid, width, height) {
  if (!grid || !grid.length) return null;
  const found = findRecipe(grid, width, height);
  return found ? found.output : null;
}

/**
 * What stays in the grid after one craft: empty buckets, glass bottles and
 * bowls. Returns an array parallel to `grid` (null where nothing remains).
 */
export function remainingItems(grid) {
  const out = new Array(grid.length).fill(null);
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i];
    if (!s || !s.item) continue;
    const remains = CONTAINER_REMAINS[s.item];
    if (remains) out[i] = mk(remains, 1);
  }
  return out;
}

// ===========================================================================
// 13. Lookup helpers for the recipe book
// ===========================================================================

/** Every recipe producing `itemName`. */
export function recipesFor(itemName) {
  return BY_OUTPUT.get(itemName) || [];
}

/** Every recipe that consumes `itemName` (tags expanded). */
export function recipesUsing(itemName) {
  return BY_INGREDIENT.get(itemName) || [];
}

/** Recipe by id, or undefined. */
export function getRecipe(id) {
  return BY_ID.get(id);
}

/** Counts every item held by an Inventory, an array of stacks, or a Map. */
function countItems(inventory) {
  const counts = new Map();
  if (!inventory) return counts;
  const push = (s) => {
    if (!s || !s.item || !(s.count > 0)) return;
    counts.set(s.item, (counts.get(s.item) || 0) + s.count);
  };
  if (Array.isArray(inventory)) {
    for (const s of inventory) push(s);
  } else if (inventory instanceof Map) {
    for (const [k, v] of inventory) counts.set(k, (counts.get(k) || 0) + v);
  } else if (typeof inventory.size === 'number' && typeof inventory.get === 'function') {
    for (let i = 0; i < inventory.size; i++) push(inventory.get(i));
  } else if (Array.isArray(inventory.slots)) {
    for (const s of inventory.slots) push(s);
  } else {
    for (const k in inventory) {
      const v = inventory[k];
      if (typeof v === 'number') counts.set(k, (counts.get(k) || 0) + v);
    }
  }
  return counts;
}

function availableFor(ing, counts) {
  if (isTag(ing)) {
    const list = TAGS[ing];
    if (!list) return 0;
    let n = 0;
    for (const name of list) n += counts.get(name) || 0;
    return n;
  }
  if (Array.isArray(ing)) {
    let n = 0;
    for (const i of ing) n += availableFor(i, counts);
    return n;
  }
  const key = typeof ing === 'string' ? ing : (ing && ing.item);
  return counts.get(key) || 0;
}

/**
 * Every recipe the given inventory can currently complete. Indexed by first
 * ingredient so the recipe book stays cheap to refresh.
 * `gridSize` is 2 for the inventory grid, 3 for a crafting table.
 */
export function craftableFrom(inventory, gridSize = 3) {
  const counts = countItems(inventory);
  const seen = new Set();
  const out = [];
  for (const name of counts.keys()) {
    const list = BY_INGREDIENT.get(name);
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (seen.has(r)) continue;
      seen.add(r);
      if (r.type === 'smithing') continue;
      if (r.maxDim > gridSize) continue;
      let ok = true;
      for (let k = 0; k < r.req.length; k++) {
        if (availableFor(r.req[k].ing, counts) < r.req[k].count) { ok = false; break; }
      }
      if (ok) out.push(r);
    }
  }
  return out;
}

/**
 * Resolves a smithing-table slot triple. Handles the netherite upgrades that
 * are registered above plus every armour-trim template generically.
 */
export function smithingResult(template, base, addition) {
  if (!template || !base || !addition) return null;
  const t = template.item, b = base.item, a = addition.item;
  for (const r of RECIPES) {
    if (r.type !== 'smithing') continue;
    if (r.template === t && r.base === b && r.addition === a) {
      const out = outputStack(r);
      out.damage = 0;
      if (base.enchants) out.enchants = { ...base.enchants };
      if (base.customName) out.customName = base.customName;
      const bd = getItem(b).durability | 0;
      const od = getItem(out.item).durability | 0;
      if (bd && od && base.damage) out.damage = Math.min(od - 1, Math.round((base.damage / bd) * od));
      return out;
    }
  }
  if (t.endsWith('_armor_trim_smithing_template')) {
    const def = getItem(b);
    if (!def.armor) return null;
    if (!TAG_SETS.get('#trim_materials').has(a)) return null;
    const out = mk(b, 1, { damage: base.damage || 0 });
    if (base.enchants) out.enchants = { ...base.enchants };
    if (base.color !== undefined && base.color !== null) out.color = base.color;
    out.trim = { pattern: t.slice(0, t.indexOf('_armor_trim')), material: a };
    return out;
  }
  return null;
}

// ===========================================================================
// 14. Sanity net
// ===========================================================================

// Recipes are hand-written data; a typo would silently produce an unobtainable
// item. Warn once at load rather than failing at craft time.
if (typeof console !== 'undefined') {
  const bad = [];
  for (const r of RECIPES) {
    if (!ITEMS[r.output.item]) bad.push(`${r.id} -> ${r.output.item}`);
    for (const ing of r.ingredients) {
      if (isTag(ing)) {
        if (!TAGS[ing]) bad.push(`${r.id} uses unknown tag ${ing}`);
      } else if (typeof ing === 'string' && !ITEMS[ing]) {
        bad.push(`${r.id} uses unknown item ${ing}`);
      }
    }
  }
  if (bad.length) console.warn(`[recipes] ${bad.length} problems: ${bad.slice(0, 10).join(', ')}`);
}
