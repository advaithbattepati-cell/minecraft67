// ============================================================================
// biomes.js - The biome registry (CONTRACT.md section 4).
//
// Every biome is a plain data object. Colours that Minecraft derives from a
// colormap (grass / foliage / sky) are derived here from temperature and
// downfall with the same shape of formula, so a biome only needs an explicit
// colour when vanilla overrides its colormap entry (swamp, badlands, ...).
//
// This module must stay importable in Node (tools/validate.mjs): no DOM, no
// three.js, and no reads of Game.* at module scope.
// ============================================================================
import { SEA_LEVEL } from '../core/constants.js';
import { clamp, prettyName, hsvToRgb, rgbToHex } from '../core/util.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Dense array of biome definitions, indexed by numeric id. */
export const BIOMES = [];
/** 'plains' -> definition. */
export const BIOME_BY_NAME = new Map();

let nextBiomeId = 0;

// ---- colour derivation -----------------------------------------------------
// Minecraft samples grass.png / foliage.png at (x = 1-temperature,
// y = 1-temperature*downfall). Over the region that biomes actually use, that
// colormap is very close to an affine function of (t, t*d); these three
// coefficient triples were fitted to the vanilla corner and biome samples
// (plains 0x91bd59, forest 0x79c05a, taiga 0x86b783, desert 0xbfb755).
const GRASS_BASE = [128, 180, 151];
const GRASS_T = [63, 3, -66];
const GRASS_R = [-116, 21, -33];
const FOLIAGE_BASE = [96, 161, 123];
const FOLIAGE_T = [78, 3, -81];
const FOLIAGE_R = [-143, 27, -41];

function climateColor(base, tw, rw, temperature, downfall) {
  const t = clamp(temperature, 0, 1);
  const r = clamp(downfall, 0, 1) * t;
  const cr = clamp(Math.round(base[0] + tw[0] * t + rw[0] * r), 0, 255);
  const cg = clamp(Math.round(base[1] + tw[1] * t + rw[1] * r), 0, 255);
  const cb = clamp(Math.round(base[2] + tw[2] * t + rw[2] * r), 0, 255);
  return (cr << 16) | (cg << 8) | cb;
}

const climateGrass = (t, d) => climateColor(GRASS_BASE, GRASS_T, GRASS_R, t, d);
const climateFoliage = (t, d) => climateColor(FOLIAGE_BASE, FOLIAGE_T, FOLIAGE_R, t, d);

/** Vanilla OverworldBiomes.calculateSkyColor: a hue ramp driven by temperature. */
function skyColorFor(temperature) {
  const f = clamp(temperature / 3, -1, 1);
  const [r, g, b] = hsvToRgb(0.62222224 - f * 0.05, 0.5 + f * 0.1, 1.0);
  return rgbToHex(r, g, b);
}

// Height thins the air: grass at altitude reads colder. Vanilla does this with
// a noise-perturbed lapse rate above y=80; the world is only 128 tall here, so
// the rate is scaled to still be visible on peaks.
const LAPSE_START = 80;
const LAPSE_RATE = 0.05 / 22;
const adjustTemp = (t, y) => t - Math.max(0, y - LAPSE_START) * LAPSE_RATE;

const DEFAULT_WATER = 0x3f76e4;
const DEFAULT_WATER_FOG = 0x050533;
const OVERWORLD_FOG = 0xc0d8ff;

/**
 * Registers a biome. Fills in every optional field with a sensible default and
 * derives grass/foliage/sky colours from the climate when not given.
 * Returns the numeric id.
 */
export function defineBiome(name, props = {}) {
  const temperature = props.temperature ?? 0.8;
  const downfall = props.downfall ?? 0.4;
  const dimension = props.dimension ?? 'overworld';
  const overworld = dimension === 'overworld';
  const precipitation = props.precipitation ??
    (downfall <= 0 ? 'none' : temperature <= 0.15 ? 'snow' : 'rain');
  const def = {
    id: nextBiomeId++,
    name,
    display: props.display ?? prettyName(name),
    temperature,
    downfall,
    category: props.category ?? 'plains',
    dimension,
    // --- colours ---
    grassColor: props.grassColor ?? climateGrass(temperature, downfall),
    foliageColor: props.foliageColor ?? climateFoliage(temperature, downfall),
    waterColor: props.waterColor ?? DEFAULT_WATER,
    waterFogColor: props.waterFogColor ?? DEFAULT_WATER_FOG,
    skyColor: props.skyColor ?? (overworld ? skyColorFor(temperature) : 0x000000),
    fogColor: props.fogColor ?? (overworld ? OVERWORLD_FOG : 0x000000),
    grassColorFixed: props.grassColor !== undefined,
    foliageColorFixed: props.foliageColor !== undefined,
    // --- blocks ---
    surface: props.surface ?? 'grass_block',
    filler: props.filler ?? 'dirt',
    underwater: props.underwater ?? 'gravel',
    // --- shape ---
    minHeight: props.minHeight ?? SEA_LEVEL + 1,
    maxHeight: props.maxHeight ?? SEA_LEVEL + 10,
    scale: props.scale ?? 0.2,
    depth: props.depth ?? 0.1,
    precipitation,
    snowy: precipitation === 'snow',
    // --- content ---
    features: props.features ?? [],
    mobs: {
      passive: props.mobs?.passive ?? [],
      hostile: props.mobs?.hostile ?? [],
      water: props.mobs?.water ?? [],
      ambient: props.mobs?.ambient ?? [],
    },
    spawnChance: props.spawnChance ?? 0.1,
    // --- classification flags used by worldgen / spawning ---
    cave: props.cave ?? false,
    ocean: props.ocean ?? false,
    hidden: props.hidden ?? false,
    parent: props.parent ?? null,
  };
  BIOMES[def.id] = def;
  BIOME_BY_NAME.set(name, def);
  return def.id;
}

/** Look up a biome definition by numeric id. Falls back to plains. */
export function getBiome(id) {
  return BIOMES[id] || BIOMES[0];
}

/** Look up a biome definition by registry name. Returns undefined when unknown. */
export function biomeByName(name) {
  return BIOME_BY_NAME.get(name);
}

/** Accepts an id, a name or a definition and returns the definition. */
function resolve(biome) {
  if (biome == null) return BIOMES[0];
  if (typeof biome === 'number') return getBiome(biome);
  if (typeof biome === 'string') return BIOME_BY_NAME.get(biome) || BIOMES[0];
  return biome;
}

/**
 * Grass tint for a biome at a given altitude. Biomes with a hand-picked colour
 * (swamp, badlands, cherry grove) ignore altitude, like vanilla.
 */
export function biomeColorGrass(biome, y = SEA_LEVEL) {
  const b = resolve(biome);
  if (b.grassColorFixed) return b.grassColor;
  return climateGrass(adjustTemp(b.temperature, y), b.downfall);
}

/** Foliage (leaf / vine) tint for a biome at a given altitude. */
export function biomeColorFoliage(biome, y = SEA_LEVEL) {
  const b = resolve(biome);
  if (b.foliageColorFixed) return b.foliageColor;
  return climateFoliage(adjustTemp(b.temperature, y), b.downfall);
}

// ---------------------------------------------------------------------------
// Shared spawn tables. Weights follow vanilla's spawner cost tables.
// ---------------------------------------------------------------------------

const HOSTILE_BASE = [
  ['spider', 100], ['zombie', 95], ['zombie_villager', 5], ['skeleton', 100],
  ['creeper', 100], ['slime', 100], ['enderman', 10], ['witch', 5],
];

/** The universal overworld monster table with per-mob weight overrides (0 removes). */
function hostile(mods = null) {
  const out = [];
  for (const [m, w] of HOSTILE_BASE) {
    const v = mods && m in mods ? mods[m] : w;
    if (v > 0) out.push([m, v]);
  }
  if (mods) {
    for (const m of Object.keys(mods)) {
      if (mods[m] > 0 && !HOSTILE_BASE.some((e) => e[0] === m)) out.push([m, mods[m]]);
    }
  }
  return out;
}

const HOSTILE_STD = hostile();
const HOSTILE_SNOWY = hostile({ skeleton: 20, stray: 80, slime: 0 });
const HOSTILE_DESERT = hostile({ zombie: 19, husk: 80, slime: 0 });
const HOSTILE_OCEAN = hostile({ slime: 0, drowned: 5 });
const HOSTILE_NONE = [];

const PASSIVE_PLAINS = [['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['horse', 5], ['donkey', 1]];
const PASSIVE_FARM = [['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8]];
const PASSIVE_FOREST = [['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['wolf', 5]];
const PASSIVE_TAIGA = [['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['wolf', 8], ['rabbit', 4], ['fox', 8]];
const PASSIVE_SNOWY = [['rabbit', 10], ['polar_bear', 1]];
const PASSIVE_JUNGLE = [['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['parrot', 40], ['ocelot', 2], ['panda', 1]];
const PASSIVE_SAVANNA = [['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['horse', 1], ['donkey', 1], ['armadillo', 10]];

const AMBIENT_STD = [['bat', 10]];
const AMBIENT_CAVE = [['bat', 40]];

const WATER_OCEAN = [['squid', 10], ['cod', 10], ['dolphin', 2]];
const WATER_COLD = [['squid', 3], ['cod', 15], ['salmon', 15]];
const WATER_FROZEN = [['squid', 1], ['salmon', 15]];
const WATER_WARM = [['squid', 10], ['tropical_fish', 25], ['pufferfish', 15], ['dolphin', 2]];
const WATER_RIVER = [['squid', 2], ['salmon', 5]];

// ---------------------------------------------------------------------------
// Shared feature fragments. Every name here must exist in world/features.js.
// ---------------------------------------------------------------------------

const SPRINGS = ['spring_water:20', 'spring_lava:8'];
const DISKS = ['disk_sand:3', 'disk_clay:1', 'disk_gravel:1'];

// ===========================================================================
// Overworld: flat and rolling land
// ===========================================================================

defineBiome('plains', {
  temperature: 0.8, downfall: 0.4, category: 'plains',
  surface: 'grass_block', filler: 'dirt', underwater: 'gravel',
  minHeight: 63, maxHeight: 70, depth: 0.125, scale: 0.05,
  features: [...SPRINGS, ...DISKS, 'oak_tree:0.05', 'grass_patch:10', 'flower_plains:4',
    'tall_grass_patch:1', 'pumpkin_patch:0.04', 'sugar_cane:1'],
  mobs: { passive: PASSIVE_PLAINS, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('sunflower_plains', {
  temperature: 0.8, downfall: 0.4, category: 'plains', parent: 'plains',
  minHeight: 63, maxHeight: 70, depth: 0.125, scale: 0.05,
  features: [...SPRINGS, ...DISKS, 'oak_tree:0.05', 'grass_patch:10', 'flower_plains:8',
    'tall_grass_patch:2', 'pumpkin_patch:0.04'],
  mobs: { passive: PASSIVE_PLAINS, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('snowy_plains', {
  temperature: 0.0, downfall: 0.5, category: 'snowy', precipitation: 'snow',
  surface: 'grass_block', filler: 'dirt', underwater: 'gravel',
  minHeight: 63, maxHeight: 70, depth: 0.125, scale: 0.05,
  features: [...SPRINGS, ...DISKS, 'spruce_tree:0.02', 'grass_patch:1'],
  mobs: { passive: PASSIVE_SNOWY, hostile: HOSTILE_SNOWY, ambient: AMBIENT_STD, water: [] },
});

defineBiome('ice_spikes', {
  temperature: 0.0, downfall: 0.5, category: 'snowy', precipitation: 'snow', parent: 'snowy_plains',
  surface: 'snow_block', filler: 'dirt', underwater: 'gravel',
  minHeight: 63, maxHeight: 72, depth: 0.425, scale: 0.45,
  features: ['ice_spike:15', 'spring_water:12', 'grass_patch:0.5'],
  mobs: { passive: PASSIVE_SNOWY, hostile: HOSTILE_SNOWY, ambient: AMBIENT_STD, water: [] },
});

defineBiome('desert', {
  temperature: 2.0, downfall: 0.0, category: 'desert', precipitation: 'none',
  surface: 'sand', filler: 'sandstone', underwater: 'sand',
  minHeight: 63, maxHeight: 71, depth: 0.125, scale: 0.05,
  features: ['spring_water:8', 'spring_lava:12', 'disk_sand:3', 'cactus:10', 'dead_bush:2',
    'sugar_cane:6', 'fossil:0.02'],
  mobs: { passive: [['rabbit', 4], ['camel', 1]], hostile: HOSTILE_DESERT, ambient: AMBIENT_STD, water: [] },
});

// ===========================================================================
// Overworld: forests
// ===========================================================================

defineBiome('forest', {
  temperature: 0.7, downfall: 0.8, category: 'forest',
  minHeight: 63, maxHeight: 75, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'oak_tree:8', 'birch_tree:2', 'big_oak_tree:1',
    'grass_patch:2', 'tall_grass_patch:1', 'flower_forest:2', 'sweet_berry_bush:0.05'],
  mobs: { passive: PASSIVE_FOREST, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('flower_forest', {
  temperature: 0.7, downfall: 0.8, category: 'forest', parent: 'forest',
  minHeight: 63, maxHeight: 74, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'oak_tree:6', 'birch_tree:2', 'flower_forest:14',
    'flower_default:4', 'grass_patch:4', 'tall_grass_patch:2'],
  mobs: { passive: [...PASSIVE_FOREST, ['bee', 5]], hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('birch_forest', {
  temperature: 0.6, downfall: 0.6, category: 'forest',
  minHeight: 63, maxHeight: 75, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'birch_tree:10', 'oak_tree:1', 'grass_patch:2',
    'tall_grass_patch:1', 'flower_default:2', 'huge_brown_mushroom:0.1'],
  mobs: { passive: PASSIVE_FARM, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('old_growth_birch_forest', {
  temperature: 0.6, downfall: 0.6, category: 'forest', parent: 'birch_forest',
  minHeight: 63, maxHeight: 78, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'tall_birch_tree:10', 'birch_tree:3', 'grass_patch:2',
    'tall_grass_patch:1', 'flower_default:2', 'huge_brown_mushroom:0.2', 'huge_red_mushroom:0.1'],
  mobs: { passive: [...PASSIVE_FARM, ['bee', 5]], hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('dark_forest', {
  temperature: 0.7, downfall: 0.8, category: 'forest',
  grassColor: 0x507a32, foliageColor: 0x59ae30,
  minHeight: 63, maxHeight: 74, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'dark_oak_tree:8', 'oak_tree:2', 'birch_tree:1',
    'big_oak_tree:0.5', 'huge_red_mushroom:0.5', 'huge_brown_mushroom:0.5',
    'grass_patch:1', 'flower_forest:1', 'vines:2'],
  mobs: { passive: PASSIVE_FARM, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('taiga', {
  temperature: 0.25, downfall: 0.8, category: 'taiga',
  minHeight: 63, maxHeight: 78, depth: 0.2, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'spruce_tree:10', 'pine_tree:2', 'fern_patch:7',
    'grass_patch:1', 'flower_default:1', 'sweet_berry_bush:1', 'huge_brown_mushroom:0.2'],
  mobs: { passive: PASSIVE_TAIGA, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('snowy_taiga', {
  temperature: -0.5, downfall: 0.4, category: 'taiga', precipitation: 'snow',
  waterColor: 0x3d57d6,
  minHeight: 63, maxHeight: 78, depth: 0.2, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'spruce_tree:6', 'pine_tree:1', 'fern_patch:2',
    'grass_patch:1', 'sweet_berry_bush:0.5'],
  mobs: {
    passive: [['wolf', 8], ['rabbit', 4], ['fox', 8], ['sheep', 4], ['pig', 4], ['chicken', 4]],
    hostile: HOSTILE_SNOWY, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('old_growth_pine_taiga', {
  temperature: 0.3, downfall: 0.8, category: 'taiga', parent: 'taiga',
  surface: 'podzol', filler: 'dirt',
  minHeight: 64, maxHeight: 84, depth: 0.2, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'pine_tree:10', 'mega_spruce_tree:3', 'spruce_tree:2',
    'fern_patch:7', 'grass_patch:2', 'huge_brown_mushroom:0.3', 'huge_red_mushroom:0.3',
    'sweet_berry_bush:1'],
  mobs: { passive: PASSIVE_TAIGA, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('old_growth_spruce_taiga', {
  temperature: 0.25, downfall: 0.8, category: 'taiga', parent: 'taiga',
  surface: 'podzol', filler: 'dirt',
  minHeight: 64, maxHeight: 84, depth: 0.2, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'mega_spruce_tree:10', 'spruce_tree:3', 'pine_tree:1',
    'fern_patch:7', 'grass_patch:2', 'huge_brown_mushroom:0.4', 'huge_red_mushroom:0.2',
    'sweet_berry_bush:1'],
  mobs: { passive: PASSIVE_TAIGA, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

// ===========================================================================
// Overworld: jungles
// ===========================================================================

defineBiome('jungle', {
  temperature: 0.95, downfall: 0.9, category: 'jungle',
  minHeight: 64, maxHeight: 82, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'jungle_tree:30', 'mega_jungle_tree:6', 'oak_tree:2',
    'bamboo:5', 'vines:50', 'grass_patch:25', 'tall_grass_patch:5', 'melon_patch:1',
    'flower_default:4'],
  mobs: { passive: PASSIVE_JUNGLE, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('sparse_jungle', {
  temperature: 0.95, downfall: 0.8, category: 'jungle', parent: 'jungle',
  minHeight: 64, maxHeight: 80, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'jungle_tree:6', 'oak_tree:2', 'grass_patch:15',
    'tall_grass_patch:3', 'vines:20', 'melon_patch:0.5', 'bamboo:1', 'flower_default:2'],
  mobs: {
    passive: [['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['parrot', 8], ['ocelot', 1]],
    hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('bamboo_jungle', {
  temperature: 0.95, downfall: 0.9, category: 'jungle', parent: 'jungle',
  minHeight: 64, maxHeight: 80, depth: 0.1, scale: 0.2,
  features: [...SPRINGS, ...DISKS, 'bamboo:50', 'jungle_tree:4', 'mega_jungle_tree:1',
    'vines:25', 'grass_patch:10', 'melon_patch:1', 'flower_default:2'],
  mobs: {
    passive: [['panda', 80], ['parrot', 40], ['ocelot', 2], ['chicken', 10], ['pig', 10], ['cow', 8]],
    hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [],
  },
});

// ===========================================================================
// Overworld: savanna and badlands
// ===========================================================================

defineBiome('savanna', {
  temperature: 2.0, downfall: 0.0, category: 'savanna', precipitation: 'none',
  minHeight: 63, maxHeight: 72, depth: 0.125, scale: 0.05,
  features: ['spring_water:12', 'spring_lava:8', ...DISKS, 'acacia_tree:2', 'oak_tree:1',
    'grass_patch:20', 'tall_grass_patch:2', 'flower_default:1'],
  mobs: { passive: PASSIVE_SAVANNA, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('savanna_plateau', {
  temperature: 2.0, downfall: 0.0, category: 'savanna', precipitation: 'none', parent: 'savanna',
  minHeight: 78, maxHeight: 90, depth: 1.5, scale: 0.025,
  features: ['spring_water:8', 'spring_lava:8', 'acacia_tree:2', 'oak_tree:1',
    'grass_patch:20', 'tall_grass_patch:2'],
  mobs: {
    passive: [...PASSIVE_SAVANNA, ['llama', 5]],
    hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('windswept_savanna', {
  temperature: 2.0, downfall: 0.0, category: 'savanna', precipitation: 'none', parent: 'savanna',
  minHeight: 66, maxHeight: 100, depth: 0.363, scale: 1.225,
  features: ['spring_water:8', 'spring_lava:8', 'disk_gravel:2', 'acacia_tree:1',
    'oak_tree:0.5', 'grass_patch:15', 'dead_bush:1'],
  mobs: { passive: PASSIVE_SAVANNA, hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('badlands', {
  temperature: 2.0, downfall: 0.0, category: 'desert', precipitation: 'none',
  grassColor: 0x90814d, foliageColor: 0x9e814d,
  surface: 'red_sand', filler: 'terracotta', underwater: 'red_sand',
  minHeight: 64, maxHeight: 84, depth: 0.1, scale: 0.2,
  features: ['spring_water:6', 'spring_lava:12', 'disk_sand:2', 'dead_bush:20',
    'cactus:5', 'fossil:0.02'],
  mobs: {
    passive: [['armadillo', 10]],
    hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('eroded_badlands', {
  temperature: 2.0, downfall: 0.0, category: 'desert', precipitation: 'none', parent: 'badlands',
  grassColor: 0x90814d, foliageColor: 0x9e814d,
  surface: 'red_sand', filler: 'terracotta', underwater: 'red_sand',
  minHeight: 64, maxHeight: 100, depth: 0.1, scale: 0.2,
  features: ['spring_water:4', 'spring_lava:12', 'dead_bush:20', 'cactus:5'],
  mobs: { passive: [['armadillo', 10]], hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

defineBiome('wooded_badlands', {
  temperature: 2.0, downfall: 0.0, category: 'desert', precipitation: 'none', parent: 'badlands',
  grassColor: 0x90814d, foliageColor: 0x9e814d,
  surface: 'coarse_dirt', filler: 'terracotta', underwater: 'red_sand',
  minHeight: 78, maxHeight: 94, depth: 1.5, scale: 0.025,
  features: ['spring_water:6', 'spring_lava:12', 'oak_tree:5', 'dead_bush:5',
    'cactus:5', 'grass_patch:1'],
  mobs: { passive: [['armadillo', 10]], hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [] },
});

// ===========================================================================
// Overworld: swamps
// ===========================================================================

defineBiome('swamp', {
  temperature: 0.8, downfall: 0.9, category: 'swamp',
  grassColor: 0x6a7039, foliageColor: 0x6a7039,
  waterColor: 0x617b64, waterFogColor: 0x232317, fogColor: 0xc0d8ff,
  surface: 'grass_block', filler: 'dirt', underwater: 'dirt',
  minHeight: 59, maxHeight: 64, depth: -0.2, scale: 0.1,
  features: ['spring_water:30', 'spring_lava:4', 'disk_clay:3', 'disk_sand:1',
    'swamp_tree:2', 'oak_tree:1', 'grass_patch:5', 'flower_swamp:1', 'lily_pad:4',
    'huge_brown_mushroom:0.25', 'huge_red_mushroom:0.25', 'sugar_cane:10',
    'dead_bush:1', 'seagrass:1', 'vines:8', 'fossil:0.02'],
  mobs: {
    passive: [['frog', 10], ['sheep', 6], ['pig', 6], ['chicken', 6], ['cow', 6]],
    hostile: hostile({ slime: 40, bogged: 20, drowned: 10 }),
    ambient: AMBIENT_STD, water: [['squid', 4], ['tropical_fish', 5]],
  },
});

defineBiome('mangrove_swamp', {
  temperature: 0.8, downfall: 0.9, category: 'swamp',
  grassColor: 0x6a7039, foliageColor: 0x8db127,
  waterColor: 0x3a7a6a, waterFogColor: 0x1f3a34, fogColor: 0xc0d8ff,
  surface: 'mud', filler: 'mud', underwater: 'mud',
  minHeight: 58, maxHeight: 64, depth: -0.2, scale: 0.1,
  features: ['spring_water:30', 'disk_clay:3', 'mangrove_tree:6', 'grass_patch:2',
    'lily_pad:4', 'seagrass:2', 'sugar_cane:6', 'vines:10', 'glow_lichen:2'],
  mobs: {
    passive: [['frog', 10]],
    hostile: hostile({ slime: 20, bogged: 20, drowned: 10 }),
    ambient: AMBIENT_STD, water: [['tropical_fish', 25], ['squid', 2]],
  },
});

// ===========================================================================
// Overworld: shores and rivers
// ===========================================================================

defineBiome('beach', {
  temperature: 0.8, downfall: 0.4, category: 'beach',
  surface: 'sand', filler: 'sand', underwater: 'sand',
  minHeight: 62, maxHeight: 65, depth: 0.0, scale: 0.025,
  features: ['spring_water:12', 'disk_sand:2', 'sugar_cane:2', 'seagrass:1'],
  mobs: { passive: [['turtle', 5]], hostile: hostile({ slime: 0, drowned: 20 }), ambient: AMBIENT_STD, water: [] },
});

defineBiome('snowy_beach', {
  temperature: 0.05, downfall: 0.3, category: 'beach', precipitation: 'snow',
  waterColor: 0x3d57d6,
  surface: 'sand', filler: 'sand', underwater: 'gravel',
  minHeight: 62, maxHeight: 65, depth: 0.0, scale: 0.025,
  features: ['spring_water:6', 'disk_gravel:2'],
  mobs: { passive: [['rabbit', 2]], hostile: hostile({ skeleton: 20, stray: 80, slime: 0, drowned: 20 }), ambient: AMBIENT_STD, water: [] },
});

defineBiome('stony_shore', {
  temperature: 0.2, downfall: 0.3, category: 'beach',
  surface: 'stone', filler: 'stone', underwater: 'gravel',
  minHeight: 62, maxHeight: 72, depth: 0.1, scale: 0.8,
  features: ['spring_water:8', 'spring_lava:4', 'disk_gravel:2', 'glow_lichen:2'],
  mobs: { passive: [], hostile: hostile({ slime: 0 }), ambient: AMBIENT_STD, water: [] },
});

defineBiome('river', {
  temperature: 0.5, downfall: 0.5, category: 'river',
  surface: 'sand', filler: 'sand', underwater: 'sand',
  minHeight: 56, maxHeight: 61, depth: -0.5, scale: 0.0,
  features: ['spring_water:24', 'disk_sand:3', 'disk_clay:2', 'disk_gravel:2',
    'seagrass:6', 'sugar_cane:2', 'grass_patch:1'],
  mobs: {
    passive: [], hostile: hostile({ slime: 0, drowned: 100 }),
    ambient: AMBIENT_STD, water: WATER_RIVER,
  },
});

defineBiome('frozen_river', {
  temperature: 0.0, downfall: 0.5, category: 'river', precipitation: 'snow',
  waterColor: 0x3938c9,
  surface: 'sand', filler: 'sand', underwater: 'gravel',
  minHeight: 56, maxHeight: 61, depth: -0.5, scale: 0.0,
  features: ['spring_water:12', 'disk_gravel:2', 'seagrass:1'],
  mobs: {
    passive: [], hostile: hostile({ skeleton: 20, stray: 80, slime: 0, drowned: 1 }),
    ambient: AMBIENT_STD, water: [['salmon', 5]],
  },
});

// ===========================================================================
// Overworld: oceans (family generator)
// ===========================================================================

/** Registers one ocean variant; `deep` picks the deeper terrain band. */
function defineOcean(name, o) {
  return defineBiome(name, {
    temperature: o.temperature, downfall: 0.5, category: 'ocean', ocean: true,
    waterColor: o.waterColor, waterFogColor: o.waterFog,
    precipitation: o.temperature <= 0.15 ? 'snow' : 'rain',
    surface: o.surface, filler: o.filler ?? 'stone', underwater: o.surface,
    minHeight: o.deep ? 26 : 40, maxHeight: o.deep ? 46 : 56,
    depth: o.deep ? -1.8 : -1.0, scale: 0.1,
    parent: o.parent ?? null,
    features: o.features,
    mobs: { passive: o.passive ?? [], hostile: o.hostile ?? HOSTILE_OCEAN, water: o.fish, ambient: AMBIENT_STD },
  });
}

const OCEAN_FEATURES = ['spring_water:8', 'disk_sand:2', 'disk_gravel:2', 'disk_clay:1',
  'kelp:12', 'seagrass:20'];
const COLD_OCEAN_FEATURES = ['spring_water:8', 'disk_gravel:3', 'disk_clay:1',
  'kelp:20', 'seagrass:8'];
const FROZEN_OCEAN_FEATURES = ['disk_gravel:3', 'seagrass:2'];
const WARM_OCEAN_FEATURES = ['disk_sand:3', 'disk_clay:1', 'coral_reef:20', 'seagrass:12'];

defineOcean('ocean', {
  temperature: 0.5, waterColor: 0x3f76e4, waterFog: 0x050533, surface: 'sand',
  features: OCEAN_FEATURES, fish: WATER_OCEAN,
});
defineOcean('deep_ocean', {
  temperature: 0.5, waterColor: 0x3f76e4, waterFog: 0x050533, surface: 'gravel', deep: true,
  parent: 'ocean', features: OCEAN_FEATURES, fish: WATER_OCEAN,
});
defineOcean('cold_ocean', {
  temperature: 0.5, waterColor: 0x3d57d6, waterFog: 0x050533, surface: 'gravel',
  features: COLD_OCEAN_FEATURES, fish: WATER_COLD,
});
defineOcean('deep_cold_ocean', {
  temperature: 0.5, waterColor: 0x3d57d6, waterFog: 0x050533, surface: 'gravel', deep: true,
  parent: 'cold_ocean', features: COLD_OCEAN_FEATURES, fish: WATER_COLD,
});
defineOcean('lukewarm_ocean', {
  temperature: 0.5, waterColor: 0x45adf2, waterFog: 0x041f33, surface: 'sand',
  features: ['spring_water:6', 'disk_sand:3', 'disk_clay:1', 'kelp:4', 'seagrass:10'],
  fish: [['squid', 8], ['cod', 8], ['pufferfish', 5], ['tropical_fish', 25], ['dolphin', 2]],
});
defineOcean('deep_lukewarm_ocean', {
  temperature: 0.5, waterColor: 0x45adf2, waterFog: 0x041f33, surface: 'sand', deep: true,
  parent: 'lukewarm_ocean',
  features: ['spring_water:6', 'disk_sand:3', 'disk_clay:1', 'kelp:4', 'seagrass:10'],
  fish: [['squid', 8], ['cod', 8], ['tropical_fish', 25], ['dolphin', 2]],
});
defineOcean('warm_ocean', {
  temperature: 0.5, waterColor: 0x43d5ee, waterFog: 0x041f33, surface: 'sand',
  features: WARM_OCEAN_FEATURES, fish: WATER_WARM,
});
defineOcean('frozen_ocean', {
  temperature: 0.0, waterColor: 0x3938c9, waterFog: 0x050533, surface: 'gravel',
  features: FROZEN_OCEAN_FEATURES, fish: WATER_FROZEN,
  passive: [['polar_bear', 1]],
  hostile: hostile({ skeleton: 20, stray: 80, slime: 0, drowned: 5 }),
});
defineOcean('deep_frozen_ocean', {
  temperature: 0.5, waterColor: 0x3938c9, waterFog: 0x050533, surface: 'gravel', deep: true,
  parent: 'frozen_ocean', features: FROZEN_OCEAN_FEATURES, fish: WATER_FROZEN,
  passive: [['polar_bear', 1]],
  hostile: hostile({ skeleton: 20, stray: 80, slime: 0, drowned: 5 }),
});

// ===========================================================================
// Overworld: rare islands
// ===========================================================================

defineBiome('mushroom_fields', {
  temperature: 0.9, downfall: 1.0, category: 'mushroom',
  surface: 'mycelium', filler: 'dirt', underwater: 'gravel',
  minHeight: 63, maxHeight: 78, depth: 0.2, scale: 0.3,
  features: [...SPRINGS, 'huge_brown_mushroom:1', 'huge_red_mushroom:1', 'grass_patch:1'],
  mobs: { passive: [['mooshroom', 8]], hostile: HOSTILE_NONE, ambient: AMBIENT_STD, water: [] },
});

// ===========================================================================
// Overworld: hills, highlands and peaks
// ===========================================================================

defineBiome('windswept_hills', {
  temperature: 0.2, downfall: 0.3, category: 'mountain',
  minHeight: 72, maxHeight: 102, depth: 1.0, scale: 0.5,
  features: [...SPRINGS, 'disk_gravel:3', 'spruce_tree:1', 'oak_tree:1', 'grass_patch:2',
    'flower_default:1', 'glow_lichen:2', 'amethyst_geode:0.01'],
  mobs: {
    passive: [['llama', 5], ['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['goat', 5]],
    hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('windswept_gravelly_hills', {
  temperature: 0.2, downfall: 0.3, category: 'mountain', parent: 'windswept_hills',
  surface: 'gravel', filler: 'stone', underwater: 'gravel',
  minHeight: 72, maxHeight: 102, depth: 1.0, scale: 0.5,
  features: [...SPRINGS, 'disk_gravel:6', 'spruce_tree:0.5', 'oak_tree:0.5',
    'grass_patch:1', 'glow_lichen:2'],
  mobs: {
    passive: [['llama', 5], ['sheep', 6], ['goat', 5]],
    hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('windswept_forest', {
  temperature: 0.2, downfall: 0.3, category: 'mountain', parent: 'windswept_hills',
  minHeight: 72, maxHeight: 100, depth: 1.0, scale: 0.5,
  features: [...SPRINGS, 'disk_gravel:2', 'spruce_tree:3', 'oak_tree:3',
    'grass_patch:3', 'flower_default:1', 'glow_lichen:2'],
  mobs: {
    passive: [['llama', 5], ['sheep', 12], ['pig', 10], ['chicken', 10], ['cow', 8], ['wolf', 4]],
    hostile: HOSTILE_STD, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('meadow', {
  temperature: 0.5, downfall: 0.8, category: 'mountain',
  waterColor: 0x0e4ecf,
  minHeight: 72, maxHeight: 90, depth: 0.5, scale: 0.05,
  features: [...SPRINGS, 'grass_patch:20', 'tall_grass_patch:2', 'flower_default:4',
    'oak_tree:0.05', 'birch_tree:0.05'],
  mobs: {
    passive: [['donkey', 1], ['rabbit', 2], ['sheep', 2], ['bee', 5]],
    hostile: hostile({ slime: 0 }), ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('cherry_grove', {
  temperature: 0.5, downfall: 0.8, category: 'forest',
  grassColor: 0xb6db61, foliageColor: 0xb6db61, waterColor: 0x5db7ef,
  minHeight: 74, maxHeight: 92, depth: 0.5, scale: 0.15,
  features: [...SPRINGS, 'cherry_tree:10', 'grass_patch:20', 'tall_grass_patch:2',
    'flower_default:4'],
  mobs: {
    passive: [['pig', 10], ['sheep', 4], ['rabbit', 4], ['bee', 5]],
    hostile: hostile({ slime: 0 }), ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('grove', {
  temperature: -0.2, downfall: 0.8, category: 'mountain', precipitation: 'snow',
  surface: 'snow_block', filler: 'dirt', underwater: 'gravel',
  minHeight: 76, maxHeight: 98, depth: 0.6, scale: 0.3,
  features: [...SPRINGS, 'spruce_tree:10', 'pine_tree:2', 'grass_patch:1', 'fern_patch:1'],
  mobs: {
    passive: [['rabbit', 4], ['wolf', 8], ['fox', 8]],
    hostile: HOSTILE_SNOWY, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('snowy_slopes', {
  temperature: -0.3, downfall: 0.9, category: 'mountain', precipitation: 'snow',
  surface: 'snow_block', filler: 'stone', underwater: 'gravel',
  minHeight: 82, maxHeight: 110, depth: 1.0, scale: 0.4,
  features: ['spring_water:8', 'grass_patch:0.5', 'glow_lichen:1'],
  mobs: {
    passive: [['rabbit', 4], ['goat', 5]],
    hostile: HOSTILE_SNOWY, ambient: AMBIENT_STD, water: [],
  },
});

defineBiome('jagged_peaks', {
  temperature: -0.7, downfall: 0.9, category: 'mountain', precipitation: 'snow',
  surface: 'snow_block', filler: 'stone', underwater: 'stone',
  minHeight: 96, maxHeight: 126, depth: 1.6, scale: 0.9,
  features: ['spring_water:4', 'glow_lichen:1'],
  mobs: { passive: [['goat', 5]], hostile: HOSTILE_SNOWY, ambient: AMBIENT_STD, water: [] },
});

defineBiome('frozen_peaks', {
  temperature: -0.7, downfall: 0.9, category: 'mountain', precipitation: 'snow',
  surface: 'packed_ice', filler: 'stone', underwater: 'stone',
  minHeight: 96, maxHeight: 126, depth: 1.6, scale: 0.9,
  features: ['spring_water:4', 'glow_lichen:1', 'ice_spike:0.5'],
  mobs: { passive: [['goat', 5]], hostile: HOSTILE_SNOWY, ambient: AMBIENT_STD, water: [] },
});

defineBiome('stony_peaks', {
  temperature: 1.0, downfall: 0.3, category: 'mountain',
  surface: 'stone', filler: 'stone', underwater: 'stone',
  minHeight: 88, maxHeight: 118, depth: 1.5, scale: 0.8,
  features: ['spring_water:4', 'spring_lava:8', 'glow_lichen:2', 'grass_patch:0.5'],
  mobs: { passive: [], hostile: hostile({ slime: 0 }), ambient: AMBIENT_STD, water: [] },
});

// ===========================================================================
// Overworld: cave biomes (chosen by 3D noise, never by the surface climate)
// ===========================================================================

defineBiome('dripstone_caves', {
  temperature: 0.8, downfall: 0.4, category: 'cave', cave: true,
  surface: 'stone', filler: 'stone', underwater: 'stone',
  minHeight: 6, maxHeight: 52, depth: 0.1, scale: 0.2,
  features: ['dripstone_cluster:40', 'glow_lichen:10', 'spring_water:8', 'spring_lava:8',
    'amethyst_geode:0.02'],
  mobs: { passive: [], hostile: HOSTILE_STD, ambient: AMBIENT_CAVE, water: [] },
});

defineBiome('lush_caves', {
  temperature: 0.8, downfall: 0.4, category: 'cave', cave: true,
  surface: 'moss_block', filler: 'stone', underwater: 'clay',
  minHeight: 6, maxHeight: 52, depth: 0.1, scale: 0.2,
  features: ['lush_cave_patch:30', 'azalea_tree:4', 'glow_lichen:20', 'spring_water:6',
    'grass_patch:4'],
  mobs: {
    passive: [], hostile: HOSTILE_STD, ambient: AMBIENT_CAVE,
    water: [['axolotl', 10], ['tropical_fish', 25], ['glow_squid', 10]],
  },
});

defineBiome('deep_dark', {
  temperature: 0.8, downfall: 0.4, category: 'cave', cave: true,
  fogColor: 0x0a0a10, skyColor: 0x0a0a10,
  surface: 'deepslate', filler: 'deepslate', underwater: 'deepslate',
  minHeight: 4, maxHeight: 36, depth: 0.1, scale: 0.2,
  features: ['sculk_patch:24', 'glow_lichen:6', 'spring_water:4'],
  mobs: { passive: [], hostile: HOSTILE_NONE, ambient: [], water: [] },
});

// ===========================================================================
// Nether
// ===========================================================================

/** Registers a nether biome; nether biomes share sky/fog and the lava sea band. */
function defineNether(name, o) {
  return defineBiome(name, {
    temperature: 2.0, downfall: 0.0, category: 'nether', dimension: 'nether',
    precipitation: 'none',
    grassColor: o.grass, foliageColor: o.foliage,
    fogColor: o.fog, skyColor: o.fog,
    waterColor: 0x3f76e4, waterFogColor: 0x050533,
    surface: o.surface, filler: o.filler, underwater: o.filler,
    minHeight: o.minHeight ?? 34, maxHeight: o.maxHeight ?? 100,
    depth: 0.1, scale: 0.2,
    features: o.features,
    mobs: { passive: [], hostile: o.hostile, water: o.water ?? [], ambient: [] },
  });
}

defineNether('nether_wastes', {
  fog: 0x330808, grass: 0x8a3c26, foliage: 0x8a3c26,
  surface: 'netherrack', filler: 'netherrack',
  features: ['spring_lava:16', 'nether_wart_patch:1', 'glow_lichen:4', 'fungus_crimson:0.1',
    'fungus_warped:0.1'],
  hostile: [['zombified_piglin', 100], ['ghast', 50], ['piglin', 15], ['magma_cube', 2], ['enderman', 1]],
  water: [['strider', 60]],
});

defineNether('soul_sand_valley', {
  fog: 0x1b4745, grass: 0x5e5e4c, foliage: 0x5e5e4c,
  surface: 'soul_sand', filler: 'soul_soil',
  features: ['soul_fire:12', 'basalt_pillar:4', 'glow_lichen:2', 'spring_lava:8'],
  hostile: [['skeleton', 20], ['ghast', 50], ['enderman', 1], ['zombified_piglin', 1]],
  water: [['strider', 60]],
});

defineNether('crimson_forest', {
  fog: 0x330303, grass: 0x942e0f, foliage: 0x942e0f,
  surface: 'crimson_nylium', filler: 'netherrack',
  features: ['fungus_crimson:8', 'weeping_vines:8', 'glow_lichen:4', 'nether_wart_patch:1',
    'spring_lava:8'],
  hostile: [['hoglin', 9], ['piglin', 5], ['zombified_piglin', 1]],
  water: [['strider', 60]],
});

defineNether('warped_forest', {
  fog: 0x1a051a, grass: 0x1a7f78, foliage: 0x1a7f78,
  surface: 'warped_nylium', filler: 'netherrack',
  features: ['fungus_warped:8', 'twisting_vines:8', 'glow_lichen:4', 'spring_lava:8'],
  hostile: [['enderman', 1]],
  water: [['strider', 60]],
});

defineNether('basalt_deltas', {
  fog: 0x685f70, grass: 0x685f70, foliage: 0x685f70,
  surface: 'basalt', filler: 'blackstone',
  minHeight: 30, maxHeight: 96,
  features: ['basalt_pillar:12', 'spring_lava:20', 'glow_lichen:2'],
  hostile: [['magma_cube', 100], ['ghast', 40], ['zombified_piglin', 1]],
  water: [['strider', 60]],
});

// ===========================================================================
// The End
// ===========================================================================

/** Registers an End biome; they all share the purple void fog and end stone. */
function defineEnd(name, o) {
  return defineBiome(name, {
    temperature: 0.5, downfall: 0.5, category: 'end', dimension: 'end',
    precipitation: 'none',
    grassColor: 0x8080a0, foliageColor: 0x8080a0,
    fogColor: 0xa080a0, skyColor: 0x000000,
    waterColor: 0x3f76e4, waterFogColor: 0x050533,
    surface: 'end_stone', filler: 'end_stone', underwater: 'end_stone',
    minHeight: o.minHeight, maxHeight: o.maxHeight, depth: 0.1, scale: 0.2,
    features: o.features ?? [],
    mobs: { passive: [], hostile: o.hostile ?? [['enderman', 10]], water: [], ambient: [] },
    hidden: o.hidden ?? false,
  });
}

defineEnd('the_end', { minHeight: 48, maxHeight: 72 });
defineEnd('end_highlands', {
  minHeight: 52, maxHeight: 84, features: ['chorus_plant:8'],
  hostile: [['enderman', 10], ['shulker', 1]],
});
defineEnd('end_midlands', { minHeight: 48, maxHeight: 70 });
defineEnd('end_barrens', { minHeight: 46, maxHeight: 62, hostile: [['enderman', 4]] });
defineEnd('small_end_islands', {
  minHeight: 50, maxHeight: 68, features: ['chorus_plant:2'], hostile: [['enderman', 4]],
});

defineBiome('the_void', {
  temperature: 0.5, downfall: 0.5, category: 'end', dimension: 'end', precipitation: 'none',
  fogColor: 0x000000, skyColor: 0x000000, hidden: true,
  surface: 'air', filler: 'air', underwater: 'air',
  minHeight: 0, maxHeight: 0, depth: 0.0, scale: 0.0,
  features: [], mobs: { passive: [], hostile: [], water: [], ambient: [] },
});

// ---------------------------------------------------------------------------
// Id lookup + the exported id groups
// ---------------------------------------------------------------------------

/** name -> id, built once after every registration above. */
const I = Object.create(null);
for (const b of BIOMES) I[b.name] = b.id;

/** Ids of every surface overworld biome (cave biomes excluded). */
export const OVERWORLD_BIOMES = BIOMES
  .filter((b) => b.dimension === 'overworld' && !b.cave && !b.hidden)
  .map((b) => b.id);

/** Ids of the five nether biomes. */
export const NETHER_BIOMES = BIOMES
  .filter((b) => b.dimension === 'nether' && !b.hidden)
  .map((b) => b.id);

/** Ids of the End biomes (the void is excluded: it is not generated). */
export const END_BIOMES = BIOMES
  .filter((b) => b.dimension === 'end' && !b.hidden)
  .map((b) => b.id);

/** Ids of the underground-only biomes. */
export const CAVE_BIOMES = BIOMES.filter((b) => b.cave).map((b) => b.id);

// ---------------------------------------------------------------------------
// Climate -> biome
// ---------------------------------------------------------------------------

// Vanilla splits temperature and humidity into five bands each. These cut
// points are on the normalized [-1, 1] range worldgen hands us.
const TEMP_CUTS = [-0.45, -0.15, 0.2, 0.55];
const HUMID_CUTS = [-0.35, -0.1, 0.1, 0.3];

function bandOf(v, cuts) {
  for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return i;
  return cuts.length;
}

// Ocean variants indexed by temperature band 0..4.
let OCEAN_BY_TEMP = null;
let DEEP_OCEAN_BY_TEMP = null;

function oceanTables() {
  if (!OCEAN_BY_TEMP) {
    OCEAN_BY_TEMP = [I.frozen_ocean, I.cold_ocean, I.ocean, I.lukewarm_ocean, I.warm_ocean];
    DEEP_OCEAN_BY_TEMP = [I.deep_frozen_ocean, I.deep_cold_ocean, I.deep_ocean,
      I.deep_lukewarm_ocean, I.warm_ocean];
  }
}

/**
 * Maps normalized climate parameters in [-1, 1] to a biome id.
 * Read as a cascade: water first, then the shoreline, then relief (peaks,
 * slopes, plateaus), then the flat-land temperature/humidity grid. `weirdness`
 * flips a biome to its rare variant; `erosion` controls how mountainous the
 * column is (low erosion = tall and sharp).
 */
export function biomeAtClimate(temperature, humidity, continentalness, erosion, weirdness) {
  oceanTables();
  const t = clamp(temperature, -1, 1);
  const h = clamp(humidity, -1, 1);
  const c = clamp(continentalness, -1, 1);
  const e = clamp(erosion, -1, 1);
  const w = clamp(weirdness, -1, 1);
  const tb = bandOf(t, TEMP_CUTS);
  const hb = bandOf(h, HUMID_CUTS);
  const odd = Math.abs(w) > 0.55;          // rare-variant flag

  // --- 1. rare mushroom islands sit in the shallow water ring ---------------
  if (c < -0.32 && c > -0.62 && w > 0.82 && h > 0.2) return I.mushroom_fields;

  // --- 2. open water -------------------------------------------------------
  if (c < -0.45) return DEEP_OCEAN_BY_TEMP[tb];
  if (c < -0.19) return OCEAN_BY_TEMP[tb];

  // --- 3. rivers: the near-zero ridge of the weirdness field ---------------
  if (Math.abs(w) < 0.055 && e > -0.6 && c < 0.8) {
    return tb === 0 ? I.frozen_river : I.river;
  }

  // --- 4. shoreline --------------------------------------------------------
  if (c < -0.05) {
    if (e < -0.6) return I.stony_shore;
    if (tb === 0) return I.snowy_beach;
    if (tb === 1 && hb >= 3) return I.stony_shore;
    return I.beach;
  }

  // --- 5. peaks (the least eroded land) ------------------------------------
  if (e < -0.75) {
    if (tb === 4) return odd ? I.eroded_badlands : I.badlands;
    if (tb <= 1) return w < 0 ? I.jagged_peaks : I.frozen_peaks;
    return I.stony_peaks;
  }

  // --- 6. high slopes ------------------------------------------------------
  if (e < -0.55) {
    if (tb === 4) return I.badlands;
    if (tb === 0) return I.snowy_slopes;
    if (tb === 1) return odd ? I.grove : I.snowy_slopes;
    return odd ? I.windswept_forest : I.windswept_hills;
  }

  // --- 7. windswept hills --------------------------------------------------
  if (e < -0.35) {
    if (tb === 4) return hb >= 3 ? I.wooded_badlands : I.badlands;
    if (tb === 0) return I.snowy_slopes;
    if (tb === 1) return odd ? I.grove : I.windswept_gravelly_hills;
    if (hb <= 1) return odd ? I.windswept_gravelly_hills : I.windswept_hills;
    return odd ? I.meadow : I.windswept_forest;
  }

  // --- 8. plateaus: mid erosion far inland ---------------------------------
  if (e < -0.15 && c > 0.32) {
    if (tb === 4) return hb >= 3 ? I.wooded_badlands : (odd ? I.eroded_badlands : I.badlands);
    if (tb === 3) return hb <= 1 ? I.savanna_plateau : I.jungle;
    if (tb === 2) return odd ? I.cherry_grove : I.meadow;
    if (tb === 1) return odd ? I.cherry_grove : I.meadow;
    return I.snowy_slopes;
  }

  // --- 9. swamps: the flattest, wettest lowland ----------------------------
  if (e > 0.55 && hb >= 3 && c < 0.6) {
    if (tb >= 4) return I.mangrove_swamp;
    if (tb >= 2) return I.swamp;
  }

  // --- 10. flat land by temperature / humidity -----------------------------
  switch (tb) {
    case 0: // frozen
      if (hb <= 2) return odd ? I.ice_spikes : I.snowy_plains;
      if (hb === 3) return I.snowy_taiga;
      return odd ? I.snowy_taiga : I.taiga;
    case 1: // cold
      if (hb === 0) return odd ? I.sunflower_plains : I.plains;
      if (hb === 1) return I.plains;
      if (hb === 2) return odd ? I.flower_forest : I.forest;
      if (hb === 3) return odd ? I.old_growth_pine_taiga : I.taiga;
      return odd ? I.old_growth_spruce_taiga : I.old_growth_pine_taiga;
    case 2: // temperate
      if (hb === 0) return odd ? I.sunflower_plains : I.plains;
      if (hb === 1) return odd ? I.flower_forest : I.plains;
      if (hb === 2) return odd ? I.flower_forest : I.forest;
      if (hb === 3) return odd ? I.old_growth_birch_forest : I.birch_forest;
      return odd ? I.old_growth_birch_forest : I.dark_forest;
    case 3: // warm
      if (hb === 0) return odd ? I.windswept_savanna : I.savanna;
      if (hb === 1) return I.savanna;
      if (hb === 2) return odd ? I.sunflower_plains : I.plains;
      if (hb === 3) return I.sparse_jungle;
      return odd ? I.bamboo_jungle : I.jungle;
    default: // hot
      if (hb === 4 && odd) return I.badlands;
      return I.desert;
  }
}
