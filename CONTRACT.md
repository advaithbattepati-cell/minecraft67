# minecraft67 — Module API Contract

**This file is normative.** Every module must match it exactly. If you are an agent
implementing one file, read this whole document first, implement *only* your assigned
file(s), and do not modify anyone else's file.

## Ground rules

1. **Vanilla ES modules.** No build step, no bundler, no TypeScript. Files are served
   as-is and loaded with `<script type="module">`.
2. **three.js** is imported as `import * as THREE from 'three';` (an import map in
   `index.html` points `three` at `./vendor/three.module.min.js`). Version r160.
3. **No external assets, ever.** No image files, no audio files, no fonts, no network
   requests. Every texture is drawn procedurally into a `<canvas>`; every sound is
   synthesized with the WebAudio API. This is a hard requirement.
4. **No top-level side effects that touch `Game.*` fields.** Building registries at
   module scope is fine (and expected). Reading `Game.world`, `Game.player`, etc. at
   module scope is not — do it inside functions.
5. Use `const`/`let`, arrow functions, classes, optional chaining. Target modern
   Chrome/Firefox/Safari. Do not use Node APIs.
6. Keep the hot path allocation-free where it matters (mesher, physics, lighting).
7. Every exported function/class gets a short JSDoc comment.
8. If you need something from another module that this contract does not define,
   **do not invent a new cross-module API** — derive it from what is here, or keep it
   private to your file.

## Directory layout and file ownership

```
index.html                 shell (already written — do not edit)
vendor/three.module.min.js three r160 (do not edit)
src/core/constants.js      DONE - global constants
src/core/util.js           DONE - math, AABB, colors, MinHeap
src/core/rng.js            DONE - RNG, Noise (perlin/simplex/fbm/ridged/cellular)
src/core/game.js           DONE - Game service locator + event bus
src/core/input.js          keyboard/mouse/pointer-lock/touch
src/core/settings.js       options, persistence, keybinds
src/world/blocks.js        block registry
src/world/chunk.js         chunk storage
src/world/world.js         chunk manager, block get/set, ticking
src/world/biomes.js        biome registry
src/world/worldgen.js      terrain generation for all 3 dimensions
src/world/features.js      trees, ores, plants, small decorations
src/world/structures.js    villages, temples, dungeons, fortresses, ...
src/world/lighting.js      sky + block light propagation
src/world/blockupdate.js   fluid flow, gravity, growth, random ticks
src/world/redstone.js      redstone power, pistons, doors, rails
src/render/atlas.js        procedural block/item texture atlas
src/render/mesher.js       chunk -> geometry buffers
src/render/chunkrenderer.js three.js chunk mesh lifecycle
src/render/sky.js          sky dome, sun, moon, stars, clouds, fog, weather
src/render/particles.js    particle system
src/render/skins.js        procedural mob/player skin canvases
src/render/models.js       box-model definitions + animation
src/render/entityrenderer.js entity mesh lifecycle
src/render/itemrender.js   item icon canvases + held-item view model
src/entity/entity.js       base Entity + AABB physics
src/entity/player.js       Player
src/entity/mobs.js         mob registry + Mob class
src/entity/ai.js           goal-based AI + A* pathfinding
src/entity/projectiles.js  arrows, fireballs, snowballs, potions, tridents
src/entity/vehicles.js     boats, minecarts
src/entity/itementity.js   dropped items, XP orbs, TNT, falling blocks
src/entity/combat.js       damage, knockback, status effect application
src/entity/spawning.js     natural mob spawning + despawning
src/item/items.js          item registry
src/item/inventory.js      Inventory, ItemStack helpers
src/item/recipes.js        crafting recipes (shaped + shapeless)
src/item/smelting.js       furnace/blast/smoker recipes + fuels
src/item/brewing.js        potion brewing
src/item/enchanting.js     enchantment registry, table, anvil
src/item/effects.js        status effect registry
src/item/loot.js           block/mob/chest loot tables
src/item/trading.js        villager professions and trades
src/ui/style.css           all CSS
src/ui/hud.js              hearts, hunger, hotbar, crosshair, boss bar
src/ui/screens.js          inventory/crafting/furnace/chest/anvil/... screens
src/ui/menu.js             title, world select, pause, settings, death
src/ui/chat.js             chat log + slash commands
src/ui/debug.js            F3 overlay
src/audio/sound.js         procedural WebAudio sound engine
src/save/save.js           IndexedDB persistence
src/main.js                boot + game loop (integrator)
```

---

## 1. Block values

A block is a `Uint16`: **low 12 bits = block id (0..4095), high 4 bits = metadata (0..15)**.
Use `packBlock(id, meta)`, `blockId(v)`, `blockMeta(v)`, `withMeta(v, m)` from
`core/constants.js`. Id `0` is always `air`.

### `src/world/blocks.js`

```js
export const BLOCKS = [];            // dense array indexed by numeric id; holes are undefined
export const BLOCK_BY_NAME = new Map(); // 'stone' -> def
export const B = {};                 // B.STONE === 1, B.OAK_LOG === 17, ... (SCREAMING_SNAKE of name)

/** Look up a block definition by numeric id (never returns undefined; falls back to air). */
export function getBlock(id) {}
/** Look up by string name. Returns undefined when unknown. */
export function blockByName(name) {}
/** Registers a block. Returns the numeric id. Used internally by this module only. */
export function defineBlock(name, props) {}
```

A block definition object has these fields (all optional except `name`, defaults shown):

```js
{
  id,                      // number, assigned by defineBlock
  name: 'oak_log',         // unique snake_case
  display: 'Oak Log',      // human-readable (defaults to prettyName(name))
  // --- appearance ---
  tex: 'oak_log',          // string OR { all, top, bottom, side, north, south, east, west }
                           // each value is a TEXTURE NAME registered in render/atlas.js
  model: 'cube',           // see model list below
  tint: null,              // null | 'grass' | 'foliage' | 'water' | 'redstone' | 'birch' | 'spruce' | number(hex)
  renderPass: 'opaque',    // 'opaque' | 'cutout' | 'translucent'  (derived automatically if omitted)
  // --- physical ---
  solid: true,             // participates in collision
  opaque: true,            // fully hides the neighbouring face and blocks all light
  filter: 15,              // light levels absorbed when passing through (0 = fully clear)
  light: 0,                // light emitted, 0..15
  liquid: null,            // null | 'water' | 'lava'
  replaceable: false,      // can be replaced by placing another block (air, water, grass, snow layer)
  gravity: false,          // falls when unsupported (sand, gravel, anvil, concrete powder)
  climbable: false,        // ladders, vines, scaffolding
  // --- mining ---
  hardness: 1.5,           // seconds with bare hand at speed 1; -1 = unbreakable
  resistance: 6,           // blast resistance
  tool: null,              // null | 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'shears' | 'sword'
  tier: 0,                 // minimum tool tier for drops (0 wood .. 4 netherite)
  requiresTool: false,     // if true, drops nothing without the right tool+tier
  // --- behaviour ---
  drops: 'oak_log',        // string | array of {item, count, chance} | function(ctx) -> ItemStack[]
                           // ctx = { block, meta, tool, fortune, silkTouch, rng, world, x, y, z }
  flammable: 0,            // 0..100 encouragement (0 = fireproof)
  burnTime: 0,             // ticks this block burns as furnace fuel when held as an item
  sound: 'stone',          // 'stone'|'wood'|'grass'|'gravel'|'sand'|'glass'|'wool'|'metal'|'snow'|'slime'|'ladder'|'anvil'|'nether_wart'
  slipperiness: 0.6,       // ice = 0.98, slime = 0.8
  entityType: null,        // 'chest'|'furnace'|'sign'|'spawner'|'brewing_stand'|'hopper'|'jukebox'|'beacon'|'note_block'|'bed'|'banner'|'shulker_box'|'lectern'|'campfire'
  ticksRandomly: false,    // eligible for random ticks (crops, grass spread, leaf decay, fire, ice melt)
  itemName: null,          // item this block gives in the creative menu (defaults to name)
  group: 'building',       // creative-tab group: building, decoration, redstone, transport, misc, food, tools, combat, brewing
  // --- collision / shape ---
  collision: 'full',       // 'full' | 'none' | 'half' | 'thin' | 'custom'
  boxes: null,             // for collision:'custom', array of [x0,y0,z0,x1,y1,z1] in 0..1 block space
}
```

Models the mesher must support (`model` field):
`cube`, `column` (meta = axis 0:y 1:x 2:z), `cross` (X-shaped plant), `slab` (meta bit0 = top),
`stairs` (meta bits0-1 = horizontal facing, bit2 = upside down), `fence`, `fence_gate`,
`wall`, `pane` (glass panes / iron bars), `torch` (meta 0 = floor, 1..4 = wall facing N/E/S/W),
`fluid`, `layer` (snow, meta = layers-1), `carpet`, `flat` (pressure plate, rail: meta = shape),
`crop` (meta = growth stage; texture name gets `_stage<N>` suffix), `door`
(meta bit0 = upper half, bits1-2 = facing, bit3 = open), `trapdoor` (bits0-1 facing, bit2 open, bit3 top),
`ladder` (meta = facing), `cactus`, `chest`, `bed` (bits0-1 facing, bit2 head), `sign`,
`wall_sign`, `button`, `lever`, `anvil`, `cauldron`, `hopper`, `end_rod`, `lantern`,
`farmland`, `path`, `piston`, `piston_head`, `rail`, `vine`, `skull`, `pot`, `none`.
Anything not in this list must render as `cube`.

**Helper predicates every consumer relies on:**

```js
export function isAir(id) {}
export function isSolid(id) {}            // has collision
export function isOpaque(id) {}           // hides faces / blocks light
export function isLiquid(id) {}
export function isReplaceable(id) {}
export function lightEmission(id) {}      // 0..15
export function lightFilter(id) {}        // 0..15
export function getTexture(id, meta, face) {}  // -> texture NAME string for a face (0..5, see FACE_* constants)
```

Required block families (implement all of them, with stairs/slabs/fences/walls/buttons/
pressure plates/doors/trapdoors/fence gates/signs where Minecraft has them):

- **Stone family**: stone, granite, diorite, andesite + polished variants, cobblestone,
  mossy cobblestone, stone bricks (+ mossy/cracked/chiseled), smooth stone, deepslate
  (+ cobbled/polished/bricks/tiles/chiseled), tuff, calcite, dripstone, blackstone
  (+ polished/bricks/gilded), basalt (+ polished/smooth), bedrock, obsidian, crying obsidian,
  netherrack, nether bricks (+ red/cracked/chiseled), end stone, end stone bricks, purpur
  (+ pillar), prismarine (+ bricks/dark), quartz block (+ chiseled/pillar/bricks/smooth),
  magma block, soul sand, soul soil, glowstone, sea lantern, shroomlight, amethyst
  (block + budding + clusters), moss block, mud, packed mud, mud bricks.
- **Dirt family**: dirt, coarse dirt, rooted dirt, grass block, podzol, mycelium, farmland,
  dirt path, sand, red sand, sandstone family (+ red), gravel, clay, terracotta + 16 colours,
  glazed terracotta ×16, snow block, snow layer, ice, packed ice, blue ice, frosted ice.
- **Wood**: oak, spruce, birch, jungle, acacia, dark oak, mangrove, cherry, crimson, warped —
  each with log, stripped log, wood, stripped wood, planks, stairs, slab, fence, fence gate,
  door, trapdoor, button, pressure plate, sign, sapling (where applicable), leaves.
- **Ores**: coal, iron, copper, gold, redstone, lapis, diamond, emerald, quartz (nether),
  ancient debris, plus deepslate variants of each, plus nether gold ore.
- **Metal/mineral blocks**: coal, iron, copper (+ exposed/weathered/oxidized/waxed & cut),
  gold, redstone, lapis, diamond, emerald, netherite, raw iron/copper/gold blocks, bone block.
- **Coloured sets ×16**: wool, carpet, concrete, concrete powder, stained glass,
  stained glass pane, beds, banners, shulker boxes, candles.
- **Plants**: grass, tall grass, fern, large fern, dead bush, seagrass, kelp, vines, glow lichen,
  lily pad, 12 flowers (dandelion, poppy, blue orchid, allium, azure bluet, red/orange/white/pink
  tulip, oxeye daisy, cornflower, lily of the valley, wither rose), sunflower, lilac, rose bush,
  peony, sugar cane, bamboo, cactus, mushrooms (red/brown + huge variants), nether wart,
  crimson/warped roots & fungus, weeping/twisting vines, sculk family, pitcher/torchflower.
- **Crops**: wheat, carrots, potatoes, beetroot, melon, pumpkin (+ carved/jack o'lantern),
  cocoa, sweet berry bush, chorus flower/plant, sea pickle.
- **Utility**: crafting table, furnace, blast furnace, smoker, chest, trapped chest, ender chest,
  barrel, hopper, dropper, dispenser, observer, piston, sticky piston, note block, jukebox,
  bookshelf, chiseled bookshelf, lectern, enchanting table, anvil (3 damage stages),
  brewing stand, cauldron, beacon, conduit, respawn anchor, lodestone, loom, smithing table,
  stonecutter, grindstone, cartography table, fletching table, composter, bell, campfire
  (+ soul), scaffolding, ladder, torch (+ soul/redstone/wall variants), lantern (+ soul),
  end rod, TNT, spawner, end portal frame, end portal, nether portal, beehive, bee nest,
  target, lightning rod, sponge (+ wet), slime block, honey block, cobweb, chain, iron bars,
  glass, tinted glass, flower pot, cake, sculk sensor, redstone components (dust, repeater,
  comparator, redstone block, lever, buttons, pressure plates, tripwire, daylight detector,
  rails: normal/powered/detector/activator), doors (iron + wood), trapdoors, water, lava, fire,
  soul fire, air, cave air, void air, barrier, structure void, dragon egg, bedrock.

Aim for **600+ registered blocks**. Assign ids sequentially starting at 1.

---

## 2. `src/world/chunk.js`

```js
export class Chunk {
  constructor(cx, cz, world = null)
  cx; cz; world;
  blocks;         // Uint16Array(CHUNK_VOLUME)   packed id|meta<<12
  light;          // Uint8Array(CHUNK_VOLUME)    (sky<<4)|block
  heightmap;      // Uint8Array(256)             highest non-air y + 1, index z*16+x
  biomes;         // Uint8Array(256)             biome id, index z*16+x
  blockEntities;  // Map<localIndex, object>
  generated; populated; lit; dirty; meshVersion; empty;
  get(x, y, z)        // local 0..15 / 0..127 -> packed value (0 outside range)
  getId(x, y, z)
  getMeta(x, y, z)
  set(x, y, z, value) // returns previous value; maintains heightmap + empty flag
  setId(x, y, z, id, meta = 0)
  getLight(x, y, z); setLight(x, y, z, sky, block);
  getSky(x, y, z); getBlockLight(x, y, z);
  setSky(x, y, z, v); setBlockLight(x, y, z, v);
  getBiome(x, z); setBiome(x, z, id);
  heightAt(x, z)      // from heightmap
  recomputeHeightmap();
  getBlockEntity(x, y, z); setBlockEntity(x, y, z, obj); removeBlockEntity(x, y, z);
  serialize();        // -> plain object with typed arrays for save.js
  static deserialize(obj, world);
}
```

## 3. `src/world/world.js`

```js
export class World {
  constructor({ seed, dimension, generator })
  seed; dimension; generator;           // WorldGen instance
  chunks;            // Map<'cx,cz', Chunk>
  entities;          // array of Entity
  entitiesById;      // Map<number, Entity>
  time;              // day time in ticks, 0..23999
  totalTime;         // monotonically increasing tick counter
  weather;           // { rain: 0..1, thunder: 0..1, rainTicks, thunderTicks }
  spawnPoint;        // { x, y, z }

  getChunk(cx, cz, create = false)      // -> Chunk | null
  hasChunk(cx, cz)
  ensureChunk(cx, cz)                   // generate + populate + light if needed
  unloadChunk(cx, cz)
  chunkAt(x, z)                         // world coords -> Chunk | null

  getRaw(x, y, z)                       // packed value; 0 if unloaded, BEDROCK below 0
  getBlock(x, y, z)                     // numeric id only
  getMeta(x, y, z)
  setBlock(x, y, z, id, meta = 0, flags = 3)
      // flags bit0 = update lighting + mark mesh dirty, bit1 = notify neighbours
      // returns true when something changed
  setRaw(x, y, z, value, flags = 3)
  isSolid(x, y, z); isOpaque(x, y, z); isAir(x, y, z); isLiquid(x, y, z);
  getLight(x, y, z)                     // max(sky*dayFactor, block) 0..15 for rendering
  getSkyLight(x, y, z); getBlockLight(x, y, z);
  getBiome(x, z)                        // biome id
  biomeAt(x, z)                         // biome definition object
  getHeight(x, z)                       // highest non-air y + 1
  getTopSolid(x, z)

  getBlockEntity(x, y, z); setBlockEntity(x, y, z, obj); removeBlockEntity(x, y, z);

  addEntity(e); removeEntity(e);
  entitiesInAABB(box, filter = null)     // -> Entity[]
  entitiesNear(x, y, z, radius, filter = null)
  nearestEntity(x, y, z, radius, filter)

  /** DDA voxel raycast. Returns null or
   *  { x, y, z, face, blockId, meta, px, py, pz, distance } where px/py/pz is the hit point. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 5, opts = { fluids: false })

  markDirty(x, y, z)                     // flags the containing chunk + touched neighbours
  scheduleTick(x, y, z, delayTicks, id)  // for fluids/redstone/growth
  tick(dt)                               // advances time, weather, block ticks, entities
  isDay(); isNight(); skyLightFactor();   // 0..1 daylight multiplier
  canSeeSky(x, y, z)
}
```

`raycast` must step voxel-by-voxel (Amanatides & Woo), skipping blocks whose
`collision === 'none'` unless `opts.fluids` is set.

## 4. `src/world/biomes.js`

```js
export const BIOMES = [];               // dense array indexed by id
export const BIOME_BY_NAME = new Map();
export function getBiome(id) {}
export function biomeByName(name) {}
```

Biome definition:

```js
{
  id, name, display,
  temperature: 0.8, downfall: 0.4, // 0..2 / 0..1
  category: 'forest',              // plains|forest|desert|jungle|savanna|taiga|snowy|swamp|ocean|beach|mountain|mushroom|nether|end|cave|river
  dimension: 'overworld',
  grassColor: 0x79c05a, foliageColor: 0x59ae30, waterColor: 0x3f76e4, waterFogColor: 0x050533,
  skyColor: 0x78a7ff, fogColor: 0xc0d8ff,
  surface: 'grass_block', filler: 'dirt', underwater: 'gravel', // block NAMES
  minHeight: 62, maxHeight: 74,    // target terrain band, used by worldgen
  scale: 0.2, depth: 0.1,          // classic MC-style terrain shaping params
  precipitation: 'rain',           // 'rain' | 'snow' | 'none'
  features: ['oak_tree:0.1', 'grass:8', 'flower:2'],  // feature name : per-chunk attempts/chance
  mobs: { passive: [['cow',8],['sheep',12]], hostile: [['zombie',10]], water: [], ambient: [['bat',2]] },
}
```

Provide at least 45 biomes covering: plains, sunflower plains, forest, flower forest,
birch forest, old growth birch forest, dark forest, taiga, snowy taiga, old growth pine/spruce
taiga, jungle, sparse jungle, bamboo jungle, savanna, savanna plateau, windswept savanna,
desert, badlands, eroded badlands, wooded badlands, swamp, mangrove swamp, beach, snowy beach,
stony shore, river, frozen river, ocean, deep ocean, cold/lukewarm/warm/frozen ocean variants,
mushroom fields, windswept hills, windswept gravelly hills, windswept forest, meadow, grove,
snowy slopes, jagged peaks, frozen peaks, stony peaks, snowy plains, ice spikes, dripstone caves,
lush caves, deep dark, nether wastes, soul sand valley, crimson forest, warped forest,
basalt deltas, the end, end highlands, end midlands, end barrens, small end islands.

## 5. `src/world/worldgen.js`

```js
export class WorldGen {
  constructor(seed, dimension)
  seed; dimension;
  /** Fills chunk.blocks with terrain + biomes. Must be deterministic in (seed, cx, cz). */
  generateChunk(chunk)
  /** Adds trees, ores, structures, decorations. Runs after the 8 neighbours exist. */
  populateChunk(chunk, world)
  /** Biome id at world column. */
  biomeAt(x, z)
  /** Surface height at world column (used for spawn finding and structures). */
  heightAt(x, z)
  /** Picks a safe spawn point. -> {x,y,z} */
  findSpawn(world)
}
export function createGenerator(seed, dimension) {}
```

Overworld generation must include: multi-octave continent/erosion/peaks-and-valleys noise,
a temperature/humidity biome map with smooth blending, 3D density noise for overhangs,
carved cheese/spaghetti/noodle caves, ravines, aquifers/lava lakes, ore distribution by
depth, bedrock roof/floor, and sea level water fill. Nether: netherrack with soul sand
valleys, lava sea at y=31, basalt deltas, nether fortress hooks. End: central island plus
outer islands with chorus plants and end cities.

## 6. `src/world/features.js`

```js
export const FEATURES = new Map();   // name -> function(world, x, y, z, rng, args) -> boolean
export function registerFeature(name, fn) {}
export function placeFeature(name, world, x, y, z, rng, args) {}
export function generateOres(chunk, world, rng) {}
export function decorateChunk(chunk, world, rng) {}  // called by worldgen.populateChunk
```

Trees: oak, big oak, birch, tall birch, spruce, mega spruce, pine, jungle, mega jungle, acacia,
dark oak, mangrove, cherry, azalea, swamp oak, fancy oak, crimson/warped fungus, huge mushrooms.
Plus: sugar cane, cactus, pumpkin/melon patches, bamboo, kelp/seagrass, coral reefs, lily pads,
flowers by biome, grass patches, dead bushes, ice spikes, amethyst geodes, dripstone clusters,
lush cave patches (moss, glow berries, azalea), fossil, blue/brown mushroom fields, sculk patches.

## 7. `src/world/structures.js`

```js
export const STRUCTURES = new Map();  // name -> { spacing, separation, salt, dimension, biomes, generate(world, cx, cz, rng) }
export function registerStructure(name, def) {}
/** Returns the structure that should start in this chunk, or null. */
export function structureAt(seed, cx, cz, dimension, biomeName) {}
export function generateStructures(chunk, world, rng) {}
```

Structures: village (plains/desert/savanna/taiga/snowy, with houses, farms, wells, paths,
villagers, iron golem), desert pyramid, jungle temple, witch hut, igloo, pillager outpost,
woodland mansion, ocean monument, ocean ruins, shipwreck, buried treasure, dungeon (spawner +
chests), mineshaft (corridors, rails, cobwebs, cave spider spawners), stronghold (portal room,
libraries, corridors), ruined portal, desert well, fossil, amethyst geode, trail ruins,
ancient city, nether fortress (bridges, blaze spawners, wart), bastion remnant, end city
(+ ship with elytra), obsidian pillars with end crystals.

## 8. `src/world/lighting.js`

```js
/** Flood-fill block light from a source. */
export function addBlockLight(world, x, y, z, level) {}
export function removeBlockLight(world, x, y, z) {}
/** Full sky light column pass for a freshly generated chunk. */
export function initSkyLight(world, chunk) {}
/** Incremental update after a block change. */
export function updateLight(world, x, y, z, oldId, newId) {}
/** Drains queued propagation work with a time budget (ms). Returns work done. */
export function processLightQueue(world, budgetMs = 4) {}
```

## 9. `src/world/blockupdate.js`

```js
export function neighborUpdate(world, x, y, z, fromX, fromY, fromZ) {}
export function randomTick(world, chunk, rng) {}    // called ~3 blocks per subchunk per tick
export function scheduledTick(world, x, y, z, id) {}
export function tickWorldBlocks(world, dt) {}       // driver: fluids, gravity, growth, fire
export function onBlockPlaced(world, x, y, z, id, meta, placer) {}
export function onBlockBroken(world, x, y, z, id, meta, breaker) {}
/** Right-click behaviour: doors, chests, buttons, crops, etc. Returns true if handled. */
export function useBlock(world, x, y, z, player, hand, face, hitX, hitY, hitZ) {}
```

Handles: water/lava flow with the 8-step spread rule, water+lava -> stone/cobble/obsidian,
sand/gravel/anvil falling, crop growth, sapling growth into trees, grass spread/decay, leaf
decay, fire spread and burnout, ice/snow melt and form, cactus/sugar cane/bamboo growth,
vine growth, nether portal ignition and travel, TNT ignition, bed use, composter, cauldron.

## 10. `src/world/redstone.js`

```js
export function getPower(world, x, y, z) {}         // 0..15
export function isPowered(world, x, y, z) {}
export function updateRedstone(world, x, y, z) {}
export function tickRedstone(world) {}
export function tryMovePiston(world, x, y, z, extend) {}
```

## 11. `src/render/atlas.js`

Everything drawn procedurally. **No image files.**

```js
/** Registers a 16x16 texture generator. fn(ctx, rng, size) draws into a 16x16 canvas 2D context. */
export function defineTexture(name, fn) {}
/** Builds the atlas canvas + THREE.Texture. Call once during boot. Returns the Atlas. */
export function buildAtlas() {}

export const Atlas = {
  texture,        // THREE.Texture (NearestFilter, no mipmaps, flipY = false)
  canvas,         // HTMLCanvasElement 1024x1024 = 64x64 tiles of 16px
  size: 1024, tile: 16, cols: 64,
  index(name),    // -> tile index (0 if missing)
  uv(name),       // -> { u0, v0, u1, v1 } with a half-texel inset
  uvIndex(i),     // -> same for a raw tile index
  tileCanvas(name), // -> a standalone 16x16 canvas for that texture (for item icons / UI)
  has(name),
};
export const TEXTURE_NAMES = [];   // every registered name
```

Texture names follow the block/item name, with suffixes for faces: `grass_block_top`,
`grass_block_side`, `oak_log_top`, `wheat_stage0`.. Textures for tinted blocks (grass, leaves,
water) must be drawn **greyscale/white**; the mesher multiplies by the biome tint colour.

Provide drawing helpers inside the module (not exported cross-module) such as noise fills,
plank patterns, brick patterns, ore speckles, gradient shading and dithering, and use the
seeded `RNG` from `core/rng.js` so the atlas is identical every run.

Register a texture for **every** block face and **every** item in `item/items.js`.
Missing textures must fall back to a magenta/black checker rather than crashing.

## 12. `src/render/mesher.js`

```js
/**
 * Builds render geometry for one chunk.
 * Returns { opaque, cutout, translucent } where each is either null or
 * { position: Float32Array, normal: Float32Array, uv: Float32Array,
 *   color: Float32Array,  // rgb per vertex: light * ambient occlusion * biome tint
 *   index: Uint32Array }
 */
export function meshChunk(world, chunk) {}
/** Collision/selection box list for a block, in world coordinates. */
export function blockBoxes(id, meta, x, y, z) {}   // -> AABB[]
```

Requirements: hidden-face culling against neighbours (including across chunk borders),
smooth per-vertex lighting with ambient occlusion, per-face directional shading
(top 1.0, north/south 0.8, east/west 0.6, bottom 0.5), biome tinting for grass/foliage/water,
correct handling of all `model` types listed in §1, animated water/lava via UV scroll handled
by the material (not the mesher), and no allocations per block beyond reusable scratch arrays.

## 13. `src/render/chunkrenderer.js`

```js
export class ChunkRenderer {
  constructor(scene)
  materials;              // { opaque, cutout, translucent }
  update(world, player, budgetMs)   // meshes dirty chunks within budget
  setChunkDirty(cx, cz)
  removeChunk(cx, cz)
  clear()
  setRenderDistance(n)
  get stats()             // { rendered, meshed, queued }
}
```

Uses `THREE.MeshBasicMaterial` variants with `vertexColors: true` and the atlas map;
frustum culling per chunk; a fog uniform matching `sky.js`.

## 14. `src/render/skins.js`

```js
/** Returns a canvas holding the 64x64 (or 64x32) skin for a model. Cached. */
export function getSkin(name) {}
/** Returns a THREE.Texture wrapping that canvas. Cached. */
export function getSkinTexture(name) {}
export function defineSkin(name, fn) {}   // fn(ctx, rng) draws the 64x64 skin
```

A skin for every mob and the player. Drawn procedurally.

## 15. `src/render/models.js`

```js
/** A model is a tree of boxes in Minecraft's 16-units-per-block space. */
export const MODELS = {};   // name -> ModelDef
export function defineModel(name, def) {}
export function buildModel(name)   // -> { group: THREE.Group, parts: Record<string, THREE.Object3D> }
export function animateModel(inst, entity, partialTicks) {}
```

`ModelDef`:
```js
{
  texWidth: 64, texHeight: 64,
  parts: [
    { name: 'head', pivot: [0, 24, 0], pos: [-4, -8, -4], size: [8, 8, 8], uv: [0, 0],
      inflate: 0, parent: null, children: [...] },
  ],
  animate(parts, entity, t) {},   // t = { age, limbSwing, limbSwingAmount, headYaw, headPitch, partial }
}
```

Models needed: player/humanoid (zombie, skeleton, husk, drowned, stray, wither skeleton,
piglin, zombified piglin, villager, witch, illagers, iron golem variant), quadruped (cow, pig,
sheep, mooshroom, horse family, llama, goat, polar bear, panda, fox, wolf, cat, ocelot, rabbit,
strider, hoglin), creeper, spider, enderman, slime/magma cube, blaze, ghast, squid, glow squid,
bat, chicken, fish (cod, salmon, tropical, pufferfish), dolphin, turtle, axolotl, frog, tadpole,
bee, silverfish, endermite, guardian, elder guardian, shulker, phantom, vex, allay, warden,
ravager, iron golem, snow golem, ender dragon, wither, camel, sniffer, armor stand, boat,
minecart, and dropped-item/XP-orb billboards.

## 16. `src/render/entityrenderer.js`

```js
export class EntityRenderer {
  constructor(scene)
  update(world, dt, camera)   // syncs three objects with world.entities, animates, culls
  clear()
}
```

## 17. `src/render/itemrender.js`

```js
/** 32x32 (or larger) canvas icon for an item stack. Cached by item name. */
export function itemIcon(itemName) {}
/** Draws a stack (icon + count + durability bar) into a 2D context. */
export function drawStack(ctx, stack, x, y, size) {}
/** DOM element showing an item stack, for inventory UIs. */
export function stackElement(stack, size = 32) {}
/** First-person held item / arm model attached to the camera. */
export class HeldItemView {
  constructor(camera)
  update(player, dt)
  swing()
}
```

Block items get an isometric 3-face cube icon drawn from their atlas textures; plain items get
their flat 16x16 texture scaled up.

## 18. `src/render/sky.js`

```js
export class Sky {
  constructor(scene, camera)
  update(world, dt)     // sun/moon position, colours, stars, clouds, rain/snow, fog, lightning
  setDimension(dim)
  get fogColor()
  dispose()
}
```

## 19. `src/render/particles.js`

```js
export class Particles {
  constructor(scene)
  spawn(type, x, y, z, opts = {})  // opts: { count, vx, vy, vz, spread, color, size, life, gravity }
  blockBreak(x, y, z, blockId)
  blockHit(x, y, z, blockId, face)
  update(dt, camera)
  clear()
}
```

Types: `smoke`, `flame`, `lava`, `bubble`, `splash`, `rain`, `crit`, `magic`, `enchant`,
`heart`, `angry`, `note`, `portal`, `explosion`, `cloud`, `dust`, `block`, `sweep`, `slime`,
`snowball`, `firework`, `drip_water`, `drip_lava`, `soul`, `campfire_smoke`, `end_rod`,
`totem`, `damage`, `spore`, `cherry`.

## 20. `src/entity/entity.js`

```js
export class Entity {
  constructor(world, x, y, z)
  static nextId;
  id; type; world; x; y; z; px; py; pz;        // p* = previous position for interpolation
  vx; vy; vz; yaw; pitch; headYaw;
  width; height; eyeHeight;
  onGround; inWater; inLava; inWeb; submerged;
  health; maxHealth; dead; removed; age; fireTicks; hurtTime; deathTime;
  invulnerable; noClip; gravity; drag; stepHeight;
  effects;      // Map<effectName, {level, ticks, ambient}>
  fallDistance; airSupply; lastDamageSource;
  velocityScale; canPickUpLoot;

  aabb(out)                        // -> AABB
  update(dt)                       // called every frame; default does physics + effects
  tick()                           // called 20x/second
  move(dx, dy, dz)                 // swept AABB collision against the world
  applyGravity(dt)
  hurt(amount, source)             // -> boolean (whether damage applied)
  heal(amount)
  kill(); remove();
  addEffect(name, ticks, level); removeEffect(name); hasEffect(name); getEffect(name);
  distanceTo(e); distanceToSq(x, y, z);
  lookAt(x, y, z);
  isAlive();
  getEyePos(out)                   // -> {x,y,z}
  knockback(dx, dz, strength)
  serialize(); static deserialize(obj, world);
}
export class LivingEntity extends Entity { ... }   // adds limbSwing, attack cooldown, armor, drops
```

`move()` must resolve axis-by-axis against every intersecting block AABB from
`blockBoxes()`, support `stepHeight`, set `onGround`, and handle ladders, water/lava drag,
cobwebs, slime blocks, honey and ice friction.

## 21. `src/entity/player.js`

```js
export class Player extends LivingEntity {
  constructor(world, x, y, z)
  inventory;        // Inventory (see §26)
  selectedSlot;     // 0..8
  hunger; saturation; exhaustion;
  xp; xpLevel; xpProgress;
  gameMode; flying; canFly; sprinting; sneaking; swimming;
  breakProgress; breakTarget; useTicks; usingItem;
  respawnPoint; screen;       // currently-open screen name or null

  update(dt)
  handleInput(input, dt)
  getHeldItem(); getOffhandItem(); setHeldItem(stack);
  giveItem(stack)             // -> leftover stack or null
  dropItem(stack, throwIt)
  mineTick(dt)                // block breaking progress against breakTarget
  attack(entity)
  useItem(); stopUsingItem();
  addXP(n); addExhaustion(n); eat(stack);
  respawn(); teleport(x, y, z, dimension);
  getReach(); getAttackDamage(); getArmorPoints();
  raycastTarget()             // -> { block: hit|null, entity: Entity|null }
}
```

## 22. `src/entity/mobs.js`

```js
export const MOBS = {};                   // name -> definition
export function defineMob(name, def) {}
export function createMob(name, world, x, y, z, opts = {}) {}   // -> Mob instance or null
export class Mob extends LivingEntity {}
export const MOB_NAMES = [];
```

Mob definition:
```js
{
  name: 'zombie', display: 'Zombie',
  category: 'hostile',     // passive|neutral|hostile|ambient|water|boss
  width: 0.6, height: 1.95, eyeHeight: 1.74,
  health: 20, armor: 2, damage: 3, attackSpeed: 1,
  speed: 0.23, followRange: 35, knockbackResist: 0,
  xp: 5, model: 'zombie', skin: 'zombie', scale: 1,
  fireImmune: false, canSwim: true, flying: false, waterMob: false,
  burnsInDay: true, avoidsSun: false, undead: true, arthropod: false,
  babyForm: true, breedItems: ['wheat'], tameItems: null, tempts: ['wheat'],
  drops: [{ item: 'rotten_flesh', min: 0, max: 2, looting: 1 }],
  rareDrops: [{ item: 'iron_ingot', chance: 0.025 }],
  equipment: [...],        // optional armour/weapon rolls
  ai: ['float', 'attack_melee', 'wander', 'look_at_player', 'look_random'],
  sounds: { idle: 'zombie_idle', hurt: 'zombie_hurt', death: 'zombie_death', step: 'step' },
  spawn: { dimension: 'overworld', biomes: null, light: [0, 7], y: [0, 127], group: [2, 4], weight: 100, surface: true },
  boss: false, bossName: null,
  onTick(mob) {}, onAttack(mob, target) {}, onDeath(mob, source) {}, onInteract(mob, player, stack) {},
}
```

Implement **all** of these mobs:
*Passive:* pig, cow, mooshroom, sheep, chicken, rabbit, horse, donkey, mule, skeleton horse,
zombie horse, llama, trader llama, wandering trader, villager, cat, ocelot, wolf, parrot, fox,
bee, turtle, cod, salmon, tropical fish, pufferfish, squid, glow squid, dolphin, axolotl, bat,
frog, tadpole, allay, sniffer, camel, goat, panda, polar bear, strider, armadillo, snow golem,
iron golem, mooshroom (brown), armor stand.
*Hostile:* zombie, zombie villager, husk, drowned, skeleton, stray, bogged, wither skeleton,
creeper, spider, cave spider, enderman, endermite, silverfish, slime, magma cube, blaze,
ghast, zombified piglin, piglin, piglin brute, hoglin, zoglin, witch, guardian, elder guardian,
shulker, phantom, vex, evoker, vindicator, pillager, ravager, illusioner, warden, breeze,
creaking.
*Bosses:* ender dragon, wither.

## 23. `src/entity/ai.js`

```js
export const GOALS = {};                 // name -> factory(mob, args) -> Goal
export function defineGoal(name, factory) {}
export class Goal { canStart(); start(); tick(); stop(); canContinue(); priority; }
export class AIController {
  constructor(mob, goalNames)
  tick()
  target;            // current attack target
  moveTo(x, y, z, speed)
  jump(); lookAt(x, y, z);
}
/** A* over walkable voxel nodes. Returns an array of {x,y,z} or null. */
export function findPath(world, mob, tx, ty, tz, maxNodes = 400) {}
```

Goals to implement: `float`, `wander`, `look_at_player`, `look_random`, `attack_melee`,
`attack_ranged`, `attack_bow`, `avoid_entity`, `panic`, `follow_owner`, `follow_parent`,
`tempt`, `breed`, `eat_grass`, `flee_sun`, `restrict_sun`, `open_door`, `break_door`,
`swim_wander`, `fly_wander`, `hurt_by_target`, `nearest_attackable_target`, `defend_village`,
`ranged_fireball`, `creeper_swell`, `leap_at_target`, `sit`, `beg`, `steal_item`,
`teleport_random`, `stare_aggro`, `guardian_beam`, `shulker_peek`, `phantom_circle`,
`ravager_charge`, `warden_sniff`, `boss_dragon`, `boss_wither`.

## 24. Other entity modules

```js
// projectiles.js
export class Projectile extends Entity {}
export function spawnProjectile(type, world, shooter, x, y, z, dx, dy, dz, opts) {}
// types: arrow, spectral_arrow, tipped_arrow, snowball, egg, ender_pearl, splash_potion,
// lingering_potion, fireball, small_fireball, dragon_fireball, wither_skull, trident,
// llama_spit, shulker_bullet, fishing_bobber, firework_rocket, experience_bottle

// itementity.js
export class ItemEntity extends Entity {}
export class XPOrb extends Entity {}
export class FallingBlock extends Entity {}
export class TNTEntity extends Entity {}
export function dropItem(world, x, y, z, stack, vx, vy, vz) {}
export function dropXP(world, x, y, z, amount) {}

// vehicles.js
export class Boat extends Entity {}
export class Minecart extends Entity {}
export function spawnVehicle(type, world, x, y, z) {}

// combat.js
export function damageEntity(target, amount, source) {}
export function explode(world, x, y, z, power, opts = { fire: false, breakBlocks: true }) {}
export function applyKnockback(target, sx, sy, sz, strength) {}
export function computeDamage(attacker, target, stack) {}
export function shootArrow(world, shooter, power, opts) {}
/** A damage source: { type, entity, direct, amount, bypassArmor, fire, magic, projectile } */
export function damageSource(type, entity = null, direct = null) {}

// spawning.js
export function trySpawnMobs(world, player) {}    // called on a timer from world.tick
export function despawnCheck(world, player) {}
export function spawnFromSpawner(world, x, y, z, be) {}
export function canSpawnAt(world, mobDef, x, y, z) {}
```

## 25. `src/item/items.js`

```js
export const ITEMS = {};                 // name -> definition
export const ITEM_NAMES = [];
export function defineItem(name, def) {}
export function getItem(name) {}         // never undefined; falls back to a stub
export function itemExists(name) {}
export const CREATIVE_TABS = [];         // [{ id, name, icon, items: [names] }]
```

Item definition:
```js
{
  name: 'diamond_sword', display: 'Diamond Sword',
  stack: 1,                       // max stack size
  texture: 'diamond_sword',       // atlas texture name
  block: null,                    // block name if this item places a block
  group: 'combat',
  rarity: 'common',               // common|uncommon|rare|epic
  tool: { kind: 'sword', tier: 3, durability: 1561, speed: 8, damage: 7, attackSpeed: 1.6 },
  armor: { slot: 'chest', defense: 8, toughness: 2, durability: 528, knockbackResist: 0 },
  food: { hunger: 6, saturation: 0.6, eatTicks: 32, effects: [], alwaysEdible: false, meat: false },
  fuel: 0,                        // furnace burn ticks
  enchantability: 10,
  repairWith: 'diamond',
  usesLeft: null,
  onUse(world, player, stack, hit) {},      // right click; return true if consumed a tick
  onUseOnBlock(world, player, stack, hit) {},
  onFinishUsing(world, player, stack) {},
  onHitEntity(attacker, target, stack) {},
  onBreakBlock(world, player, stack, x, y, z) {},
}
```

Every block that should be obtainable needs a matching item. Beyond block items, register all
of: tools & weapons for all 5 tiers, all armour for 6 materials (leather/chain/iron/gold/
diamond/netherite + turtle helmet + elytra), bow, crossbow, arrows (normal/spectral/tipped),
trident, shield, fishing rod, flint and steel, shears, bucket family (empty/water/lava/milk/
powder snow/fish×5), all foods, all raw/cooked meats, all seeds, dyes ×16, all mineral
ingots/nuggets/gems/raw ores, sticks, string, leather, feather, gunpowder, blaze rod/powder,
ender pearl/eye, ghast tear, magma cream, spider eye/fermented, sugar, glowstone dust,
redstone, glass bottle, potions (all 30+ with variants), books (normal/enchanted/writable),
paper, maps, compass, clock, recovery compass, spyglass, name tag, lead, saddle, horse armour,
banners & patterns, music discs, spawn eggs for every mob, boats & chest boats, minecarts (all
5), armor stand, totem of undying, echo shard, netherite scrap/ingot, smithing templates,
firework rockets & stars, end crystal, bone/bone meal, slimeball, honey/honeycomb bottles,
amethyst shard, copper ingot, brush, pottery sherds, goat horn, ominous bottle, all mob heads.

Target **1000+ registered items** including block items.

## 26. `src/item/inventory.js`

```js
/** An item stack is a plain object; `null` means an empty slot. */
export function stack(item, count = 1, extra = null) {}   // -> { item, count, damage:0, ... }
export function isEmpty(s) {}
export function sameItem(a, b) {}       // ignores count
export function canMerge(a, b) {}
export function copyStack(s) {}
export function maxStackSize(s) {}
export function damageStack(s, amount, owner) {}   // -> stack | null when it breaks
export function stackDisplayName(s) {}
export function stackTooltipLines(s) {}  // array of { text, color }

export class Inventory {
  constructor(size, name = '')
  size; slots; name;
  get(i); set(i, s); 
  add(s);                 // -> leftover or null
  addTo(i, s);
  remove(i, count);
  removeItem(name, count);   // -> number actually removed
  count(name);
  has(name, count = 1);
  firstEmpty(); firstMatching(pred);
  clear(); isEmpty();
  serialize(); load(data);
  onChange;               // optional callback
}
export class PlayerInventory extends Inventory {
  // 0..8 hotbar, 9..35 storage, 36..39 armour (head, chest, legs, feet), 40 offhand
  selected;
  getSelected(); getArmor(slot); setArmor(slot, s); getOffhand();
  armorPoints(); armorToughness();
  pickBlock(blockId);
}
```

## 27. Recipes, smelting, brewing, enchanting, effects, loot, trading

```js
// recipes.js
export const RECIPES = [];
export function shaped(output, pattern, keys, opts) {}      // pattern: ['XXX','X X'], keys: {X:'stone'}
export function shapeless(output, ingredients, opts) {}
/** grid = array of (stack|null), width/height 2 or 3. Returns output stack or null. */
export function matchRecipe(grid, width, height) {}
/** Which items remain after crafting (buckets, bottles). */
export function remainingItems(grid) {}
export function recipesFor(itemName) {}
export function craftableFrom(inventory) {}
// Ingredients may be a plain item name or a tag string like '#planks'.
export const TAGS = {};      // '#planks' -> [item names]

// smelting.js
export const SMELTING = new Map();      // 'furnace'|'blast_furnace'|'smoker'|'campfire' -> Map(input -> {output, xp, time})
export function smeltResult(kind, itemName) {}
export function fuelTicks(itemName) {}

// brewing.js
export const BREWING = [];
export function brewResult(ingredient, basePotion) {}
export const POTIONS = {};        // 'strength' -> { effects, color, duration, ... }

// enchanting.js
export const ENCHANTMENTS = {};   // 'sharpness' -> { name, display, maxLevel, weight, applies, conflicts, minPower, maxPower }
export function enchantmentsFor(stack, level, rng) {}
export function tableOffers(stack, bookshelves, rng, seed) {}   // -> 3 offers
export function applyEnchant(stack, ench, level) {}
export function getEnchant(stack, name) {}     // -> level (0 if none)
export function anvilResult(left, right, name) {}   // -> { stack, cost } | null

// effects.js
export const EFFECTS = {};   // 'speed' -> { id, name, display, color, beneficial, onTick, modifiers }
export function applyEffectTick(entity, name, level) {}

// loot.js
export function blockDrops(world, x, y, z, id, meta, tool, player) {}  // -> ItemStack[]
export function mobDrops(mob, source, looting) {}                       // -> ItemStack[]
export function chestLoot(tableName, rng) {}                            // -> ItemStack[]
export const LOOT_TABLES = {};

// trading.js
export const PROFESSIONS = {};   // 'farmer' -> { name, display, workstation, trades: [tier][] }
export function rollTrades(profession, level, rng) {}   // -> [{ buy, buyB, sell, maxUses, xp }]
```

## 28. UI modules

All UI is DOM-based, mounted inside `#ui-root`. Never draw UI into the WebGL canvas.

```js
// hud.js
export class HUD { constructor(root); update(dt); show(); hide(); setBossBar(name, pct, color); }
// screens.js
export class Screens {
  constructor(root)
  open(name, ctx)     // 'inventory','crafting','furnace','chest','anvil','enchanting','brewing',
                      // 'trading','creative','beacon','loom','stonecutter','grindstone','smithing',
                      // 'cartography','hopper','dispenser','sign','book','recipe_book'
  close(); isOpen(); current;
  update(dt)
}
// menu.js
export class Menu {
  constructor(root)
  showTitle(); showWorldSelect(); showCreateWorld(); showPause(); showSettings(); showDeath(); showWin();
  hide(); get visible();
}
// chat.js
export class Chat { constructor(root); addMessage(text, color); openInput(prefix); runCommand(text); update(dt); }
export const COMMANDS = {};   // '/give' -> { args, run(args, player) }
// debug.js
export class DebugOverlay { constructor(root); toggle(); update(dt); get visible(); }
```

Commands: `/give`, `/tp`, `/time`, `/weather`, `/gamemode`, `/difficulty`, `/summon`, `/kill`,
`/setblock`, `/fill`, `/seed`, `/effect`, `/enchant`, `/xp`, `/heal`, `/clear`, `/help`,
`/spawnpoint`, `/gamerule`, `/locate`, `/fly`, `/speed`, `/noclip`, `/save`.

## 29. `src/audio/sound.js`

```js
export class SoundEngine {
  constructor()
  init()                            // must be called from a user gesture
  play(name, opts = { volume: 1, pitch: 1, x, y, z })
  playAt(name, x, y, z, volume, pitch)
  stop(name)
  setListener(x, y, z, yaw)
  setVolume(category, v)
  startMusic(track); stopMusic();
}
export const SOUNDS = {};   // name -> synth descriptor
export function defineSound(name, def) {}
```

Every sound synthesized with oscillators/noise buffers/filters. Names: block step/dig/place
per material, `hurt`, `death`, `eat`, `drink`, `burp`, `explode`, `bow`, `arrow_hit`,
`click`, `door_open`, `door_close`, `chest_open`, `chest_close`, `level_up`, `xp_pickup`,
`item_pickup`, `craft`, `anvil_use`, `fizz`, `splash`, `swim`, `fire`, `portal`,
`thunder`, `rain`, mob idle/hurt/death for every mob, `creeper_hiss`, `ghast_scream`,
`enderman_teleport`, `wither_spawn`, `dragon_growl`, plus simple music tracks.

## 30. `src/save/save.js`

```js
export class SaveManager {
  constructor()
  async init()
  async listWorlds()                    // -> [{ name, seed, created, played, mode, thumbnail }]
  async saveWorld(game, name)           // player, inventory, chunks (modified only), time, weather
  async loadWorld(name)                 // -> save object
  async deleteWorld(name)
  async saveChunk(worldName, chunk)
  async loadChunk(worldName, cx, cz, dim)
  markChunkModified(chunk)
  autoSaveTick(game)
}
```

Uses IndexedDB (`minecraft67` database). Settings go to `localStorage` under `mc67.settings`.

## 31. `src/core/input.js` and `src/core/settings.js`

```js
// input.js
export class Input {
  constructor(canvas)
  keys;                 // Set of KeyboardEvent.code currently down
  mouseButtons;         // Set of 0/1/2
  dx; dy;               // accumulated mouse delta since last consume()
  wheel;                // accumulated wheel delta
  pointerLocked; touch;
  isDown(action);       // action name from settings keybinds, e.g. 'forward'
  justPressed(action); justReleased(action);
  consume();            // clears per-frame deltas and just-pressed sets; call at end of frame
  requestPointerLock(); exitPointerLock();
  enableTouchControls(root);
}
// settings.js
export const DEFAULT_KEYBINDS = { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft', inventory: 'KeyE', drop: 'KeyQ',
  chat: 'KeyT', command: 'Slash', perspective: 'F5', debug: 'F3', screenshot: 'F2',
  pickBlock: 'MouseMiddle', attack: 'Mouse0', use: 'Mouse2', hotbar1: 'Digit1', ... };
export class Settings {
  constructor()
  values;   // { renderDistance, fov, mouseSensitivity, invertY, volume:{...}, keybinds,
            //   particles, smoothLighting, vsync, guiScale, showFps, autoJump, viewBobbing,
            //   clouds, fancyGraphics, brightness, chatOpacity, fullscreen }
  get(k); set(k, v); reset(); save(); load();
}
```

## 32. `src/main.js` (integrator)

Boots everything in order, owns the render loop and the 20 Hz tick loop, and sets
`window.__gameReady = true` once the first frame has rendered. It must:

1. Create renderer/scene/camera, handle resize and context loss.
2. Build the atlas, sounds, settings, input.
3. Show the title menu; create or load a world on demand.
4. Run a fixed-timestep tick accumulator (20 Hz) plus a variable render step with
   interpolation.
5. Budget chunk generation, meshing and lighting per frame to keep frame time stable.
6. Expose `window.__gameReady`, `window.__mc = { Game, ... }` for automated tests.

---

## Style notes

- 2-space indent, semicolons, single quotes.
- Prefer plain objects and typed arrays over classes in hot paths.
- Comment the *why*, not the *what*.
- No `console.log` left in shipped paths; `console.warn`/`console.error` for real problems only.

---

## 33. Canonical naming (the glue between parallel modules)

Every block, item, mob, biome, effect, enchantment, sound and texture uses the **exact
Minecraft 1.20 registry name** in `snake_case`, with no namespace prefix:
`stone`, `oak_planks`, `diamond_pickaxe`, `zombie`, `sunflower_plains`, `fire_resistance`,
`efficiency`. This is how independently written modules stay compatible without sharing
lists. If Minecraft has no such thing, invent a name in the same style.

Derived texture names use these suffixes and nothing else:
`_top`, `_bottom`, `_side`, `_front`, `_back`, `_inner`, `_end`, `_stage0`..`_stage7`,
`_on`, `_off`, `_open`, `_upper`, `_lower`, `_overlay`. Example: `grass_block_top`,
`furnace_front_on`, `wheat_stage3`.

`render/atlas.js` must ship an **automatic fallback generator**: when a texture name is
requested that nobody registered, it derives a plausible 16x16 texture deterministically from
the name (hash the name to a hue, pick a pattern family from suffix keywords like `_log`,
`_planks`, `_ore`, `_leaves`, `_wool`, `_glass`, `_sword`, `_ingot`) and registers it on the
fly. Nothing in the game may ever crash or render magenta because a texture name was missed.

`item/items.js` must **auto-generate a block item for every entry in `BLOCKS`** that does not
already have an explicit item, taking its texture from the block's `tex` (side face preferred).
Do not hand-maintain a list of block items.

## 34. Node-side validation

`tools/validate.mjs` imports the registry modules directly in Node and cross-checks them.
Registry modules (`blocks.js`, `items.js`, `recipes.js`, `smelting.js`, `biomes.js`, `mobs.js`,
`effects.js`, `enchanting.js`, `brewing.js`, `loot.js`, `trading.js`) must therefore be
**importable without a DOM**: they may `import * as THREE from 'three'` only if THREE is never
touched at module scope, and they must not call `document`, `window` or `canvas` while loading.
