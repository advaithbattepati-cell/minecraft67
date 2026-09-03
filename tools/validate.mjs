#!/usr/bin/env node
// Cross-checks the game's registries in Node: names referenced by one module must
// exist in the module that owns them. Run with:  node tools/validate.mjs
// Requires `npm install three` locally (dev-only; the browser uses vendor/).
const problems = [];
const notes = [];
const warn = (m) => problems.push(m);
const note = (m) => notes.push(m);

const load = async (p) => {
  try { return await import('../' + p); }
  catch (e) { warn(`IMPORT FAILED ${p}: ${(e && e.message) || e}`); return null; }
};

const blocks = await load('src/world/blocks.js');
const items = await load('src/item/items.js');
const biomes = await load('src/world/biomes.js');
const mobs = await load('src/entity/mobs.js');
const recipes = await load('src/item/recipes.js');
const smelting = await load('src/item/smelting.js');
const effects = await load('src/item/effects.js');
const ench = await load('src/item/enchanting.js');
const brewing = await load('src/item/brewing.js');
const loot = await load('src/item/loot.js');
const trading = await load('src/item/trading.js');
const atlas = await load('src/render/atlas.js');
const features = await load('src/world/features.js');
const structures = await load('src/world/structures.js');

const blockNames = new Set();
const itemNames = new Set();
const mobNames = new Set();
const texNames = new Set();

if (blocks?.BLOCKS) {
  let n = 0;
  for (const b of blocks.BLOCKS) if (b) { blockNames.add(b.name); n++; }
  note(`blocks: ${n} registered`);
  if (n < 400) warn(`only ${n} blocks registered (target 600+)`);
} 
if (items?.ITEMS) {
  const n = Object.keys(items.ITEMS).length;
  for (const k of Object.keys(items.ITEMS)) itemNames.add(k);
  note(`items: ${n} registered`);
  if (n < 700) warn(`only ${n} items registered (target 1000+)`);
}
if (mobs?.MOBS) {
  const n = Object.keys(mobs.MOBS).length;
  for (const k of Object.keys(mobs.MOBS)) mobNames.add(k);
  note(`mobs: ${n} registered`);
  if (n < 60) warn(`only ${n} mobs registered (target 80+)`);
}
if (biomes?.BIOMES) {
  const n = biomes.BIOMES.filter(Boolean).length;
  note(`biomes: ${n} registered`);
  if (n < 45) warn(`only ${n} biomes registered (target 55+)`);
}
if (atlas?.TEXTURE_NAMES) {
  for (const t of atlas.TEXTURE_NAMES) texNames.add(t);
  note(`textures: ${texNames.size} registered`);
  if (texNames.size < 600) warn(`only ${texNames.size} textures registered (target 900+)`);
}
if (effects?.EFFECTS) note(`effects: ${Object.keys(effects.EFFECTS).length}`);
if (ench?.ENCHANTMENTS) note(`enchantments: ${Object.keys(ench.ENCHANTMENTS).length}`);
if (recipes?.RECIPES) {
  note(`recipes: ${recipes.RECIPES.length}`);
  if (recipes.RECIPES.length < 300) warn(`only ${recipes.RECIPES.length} recipes (target 500+)`);
}
if (features?.FEATURES) note(`features: ${features.FEATURES.size ?? Object.keys(features.FEATURES).length}`);
if (structures?.STRUCTURES) note(`structures: ${structures.STRUCTURES.size ?? Object.keys(structures.STRUCTURES).length}`);

// --- every block should have a matching item ---
if (blockNames.size && itemNames.size) {
  const SKIP = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'flowing_water', 'flowing_lava',
    'fire', 'soul_fire', 'nether_portal', 'end_portal', 'end_gateway', 'piston_head', 'moving_piston',
    'barrier', 'structure_void', 'light', 'bubble_column', 'frosted_ice', 'attached_melon_stem',
    'attached_pumpkin_stem', 'melon_stem', 'pumpkin_stem', 'cocoa', 'carrots', 'potatoes', 'beetroots',
    'wheat', 'nether_wart', 'sweet_berry_bush', 'tripwire', 'redstone_wire', 'bamboo_sapling',
    'kelp_plant', 'cave_vines', 'cave_vines_plant', 'twisting_vines_plant', 'weeping_vines_plant',
    'tall_seagrass', 'chorus_plant', 'pitcher_crop', 'torchflower_crop', 'powder_snow']);
  const missing = [...blockNames].filter((b) => !SKIP.has(b) && !itemNames.has(b) && !b.endsWith('_wall_sign'));
  if (missing.length) warn(`${missing.length} blocks have no item: ${missing.slice(0, 25).join(', ')}${missing.length > 25 ? ' ...' : ''}`);
}

// --- recipe ingredients / outputs must be real items ---
const checkName = (name, where, bag) => {
  if (!name || typeof name !== 'string') return;
  if (name.startsWith('#')) return; // tag
  if (!itemNames.size) return;
  if (!itemNames.has(name)) bag.push(`${where}: unknown item '${name}'`);
};
if (recipes?.RECIPES && itemNames.size) {
  const bad = [];
  for (const r of recipes.RECIPES) {
    const out = r.output?.item ?? r.output ?? r.result?.item ?? r.result;
    checkName(typeof out === 'string' ? out : out?.item, `recipe ${r.id ?? ''}`, bad);
    const ings = r.ingredients || Object.values(r.keys || {}) || [];
    for (const i of [].concat(ings)) {
      if (typeof i === 'string') checkName(i, 'recipe ingredient', bad);
      else if (i && typeof i.item === 'string') checkName(i.item, 'recipe ingredient', bad);
    }
  }
  if (bad.length) warn(`${bad.length} recipe name problems: ${[...new Set(bad)].slice(0, 15).join(' | ')}`);
}

// --- biome surface blocks and mob tables ---
if (biomes?.BIOMES && blockNames.size) {
  const bad = [];
  for (const b of biomes.BIOMES) {
    if (!b) continue;
    for (const k of ['surface', 'filler', 'underwater']) {
      const v = b[k];
      if (typeof v === 'string' && !blockNames.has(v)) bad.push(`biome ${b.name}.${k}='${v}'`);
    }
    if (mobNames.size) {
      for (const cat of Object.values(b.mobs || {})) {
        for (const entry of cat || []) {
          const m = Array.isArray(entry) ? entry[0] : entry?.mob ?? entry;
          if (typeof m === 'string' && !mobNames.has(m)) bad.push(`biome ${b.name} mob '${m}'`);
        }
      }
    }
  }
  if (bad.length) warn(`${bad.length} biome reference problems: ${[...new Set(bad)].slice(0, 15).join(' | ')}`);
}

// --- block textures must resolve (atlas has a fallback, so this is informational) ---
if (blocks?.BLOCKS && texNames.size) {
  const missing = new Set();
  for (const b of blocks.BLOCKS) {
    if (!b || !b.tex) continue;
    const vals = typeof b.tex === 'string' ? [b.tex] : Object.values(b.tex);
    for (const v of vals) if (typeof v === 'string' && !texNames.has(v)) missing.add(v);
  }
  if (missing.size) note(`${missing.size} block textures fall back to the generator (e.g. ${[...missing].slice(0, 12).join(', ')})`);
}

// --- mob drops must be real items ---
if (mobs?.MOBS && itemNames.size) {
  const bad = [];
  for (const [name, m] of Object.entries(mobs.MOBS)) {
    for (const d of [].concat(m.drops || [], m.rareDrops || [])) {
      const it = typeof d === 'string' ? d : d?.item;
      if (typeof it === 'string' && !itemNames.has(it)) bad.push(`${name} drops '${it}'`);
    }
  }
  if (bad.length) warn(`${bad.length} mob drop problems: ${[...new Set(bad)].slice(0, 15).join(' | ')}`);
}

// --- spawn eggs for every mob ---
if (mobNames.size && itemNames.size) {
  const missing = [...mobNames].filter((m) => !itemNames.has(m + '_spawn_egg'));
  const noEgg = new Set(['ender_dragon', 'wither', 'player', 'armor_stand', 'iron_golem', 'snow_golem', 'giant', 'illusioner']);
  const real = missing.filter((m) => !noEgg.has(m));
  if (real.length) warn(`${real.length} mobs missing spawn eggs: ${real.slice(0, 20).join(', ')}`);
}

console.log('--- notes ---');
for (const n of notes) console.log('  ' + n);
console.log('--- problems ---');
if (!problems.length) console.log('  none');
for (const p of problems) console.log('  ! ' + p);
process.exit(problems.length ? 1 : 0);
