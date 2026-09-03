// ============================================================================
// blocks.js - The block registry.
//
// Every block in the game is registered here at module scope. Ids are handed
// out sequentially starting at 0 ('air'), and a block "value" stored in a chunk
// is `id | meta << 12`, so ids must stay below 4096.
//
// Nothing in this file touches the DOM, `Game.*` or three.js, so it can be
// imported by tools/validate.mjs in plain Node.
// ============================================================================
import { prettyName } from '../core/util.js';
import { FACE_UP, FACE_NORTH, HFACE_TO_FACE, FACE_OPPOSITE, ID_MASK } from '../core/constants.js';

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

/** Dense array indexed by numeric block id. Holes are `undefined`. */
export const BLOCKS = [];
/** name -> definition. Also holds alias names that point at an existing def. */
export const BLOCK_BY_NAME = new Map();
/** SCREAMING_SNAKE name -> numeric id, e.g. `B.STONE === 1`. */
export const B = {};
/** Every `model` string actually used by a registered block. */
export const MODELS_USED = new Set();

const _names = [];

// Models the mesher is contractually obliged to support. Anything else is
// coerced to 'cube' so a typo can never produce an unrenderable block.
const VALID_MODELS = new Set([
  'cube', 'column', 'cross', 'slab', 'stairs', 'fence', 'fence_gate', 'wall', 'pane',
  'torch', 'fluid', 'layer', 'carpet', 'flat', 'crop', 'door', 'trapdoor', 'ladder',
  'cactus', 'chest', 'bed', 'sign', 'wall_sign', 'button', 'lever', 'anvil', 'cauldron',
  'hopper', 'end_rod', 'lantern', 'farmland', 'path', 'piston', 'piston_head', 'rail',
  'vine', 'skull', 'pot', 'none',
]);

// Models whose textures contain transparent texels; they need alpha testing.
const CUTOUT_MODELS = new Set([
  'cross', 'pane', 'crop', 'rail', 'flat', 'torch', 'vine', 'ladder', 'door', 'trapdoor',
  'skull', 'pot', 'lever', 'hopper', 'cauldron', 'end_rod', 'lantern', 'chest', 'none',
]);

const NAME_TO_KEY = (n) => n.toUpperCase();

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * Registers a block. Returns the numeric id.
 * Missing fields get the defaults documented in CONTRACT.md section 1.
 */
export function defineBlock(name, props = {}) {
  if (BLOCK_BY_NAME.has(name)) {
    // Registering twice is a programming error; keep the first definition.
    return BLOCK_BY_NAME.get(name).id;
  }
  const id = BLOCKS.length;
  let model = props.model || 'cube';
  if (!VALID_MODELS.has(model)) model = 'cube';

  const solid = props.solid !== undefined ? props.solid : true;
  const opaque = props.opaque !== undefined ? props.opaque : true;
  const liquid = props.liquid !== undefined ? props.liquid : null;

  let filter = props.filter;
  if (filter === undefined) filter = opaque ? 15 : 0;

  let renderPass = props.renderPass;
  if (!renderPass) {
    if (liquid) renderPass = 'translucent';
    else if (CUTOUT_MODELS.has(model) || !opaque) renderPass = 'cutout';
    else renderPass = 'opaque';
  }

  let collision = props.collision;
  if (!collision) collision = solid ? (model === 'slab' ? 'half' : 'full') : 'none';

  let drops = props.drops;
  if (drops === undefined) drops = name;
  if (drops === null) drops = [];

  const def = {
    id,
    name,
    display: props.display || prettyName(name),
    // appearance
    tex: props.tex !== undefined && props.tex !== null ? props.tex : name,
    model,
    tint: props.tint !== undefined ? props.tint : null,
    tintFaces: props.tintFaces || null,
    renderPass,
    // physical
    solid,
    opaque,
    filter,
    light: props.light || 0,
    litLight: props.litLight !== undefined ? props.litLight : null,
    litBit: props.litBit !== undefined ? props.litBit : 4,
    litAll: !!props.litAll,
    liquid,
    replaceable: !!props.replaceable,
    gravity: !!props.gravity,
    climbable: !!props.climbable,
    // mining
    hardness: props.hardness !== undefined ? props.hardness : 1.5,
    resistance: props.resistance !== undefined ? props.resistance : (props.hardness !== undefined ? props.hardness * 5 : 6),
    tool: props.tool !== undefined ? props.tool : null,
    tier: props.tier || 0,
    requiresTool: !!props.requiresTool,
    // behaviour
    drops,
    xp: props.xp || null,
    flammable: props.flammable || 0,
    burnTime: props.burnTime || 0,
    sound: props.sound || 'stone',
    slipperiness: props.slipperiness !== undefined ? props.slipperiness : 0.6,
    entityType: props.entityType || null,
    ticksRandomly: !!props.ticksRandomly,
    itemName: props.itemName !== undefined ? props.itemName : null,
    group: props.group || 'building',
    // shape
    collision,
    boxes: props.boxes || null,
    // extras used by the mesher / worldgen; harmless to other consumers
    flowTex: props.flowTex || null,
    overlay: props.overlay || null,
    waterlogged: !!props.waterlogged,
    hFacing: props.hFacing !== undefined ? props.hFacing : undefined,
  };

  BLOCKS[id] = def;
  BLOCK_BY_NAME.set(name, def);
  B[NAME_TO_KEY(name)] = id;
  MODELS_USED.add(model);
  _names.push(name);
  return id;
}

/** Adds a second lookup name for an already-registered block. */
function alias(aliasName, targetName) {
  const def = BLOCK_BY_NAME.get(targetName);
  if (!def) return -1;
  if (!BLOCK_BY_NAME.has(aliasName)) BLOCK_BY_NAME.set(aliasName, def);
  if (B[NAME_TO_KEY(aliasName)] === undefined) B[NAME_TO_KEY(aliasName)] = def.id;
  return def.id;
}

/** Look up a block definition by numeric id (never undefined; falls back to air). */
export function getBlock(id) {
  return BLOCKS[id & ID_MASK] || BLOCKS[0];
}

/** Look up by string name. Returns undefined when unknown. */
export function blockByName(name) {
  return BLOCK_BY_NAME.get(name);
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** True for the air family (air, cave air, void air). */
export function isAir(id) {
  const d = getBlock(id);
  return d.model === 'none' && d.collision === 'none' && d.filter === 0 && d.name.endsWith('air');
}
/** True when the block participates in collision. */
export function isSolid(id) {
  const d = getBlock(id);
  return d.solid && d.collision !== 'none';
}
/** True when the block fully hides neighbouring faces and blocks all light. */
export function isOpaque(id) {
  return getBlock(id).opaque;
}
/** True for water and lava. */
export function isLiquid(id) {
  return getBlock(id).liquid !== null;
}
/** True when placing another block here simply overwrites it. */
export function isReplaceable(id) {
  return getBlock(id).replaceable;
}
/** Light emitted, 0..15. `meta` is optional and lets lit variants glow. */
export function lightEmission(id, meta = 0) {
  const d = getBlock(id);
  if (d.litLight !== null && (meta & d.litBit) !== 0) return d.litLight;
  return d.light;
}
/** Light levels absorbed when passing through, 0..15. */
export function lightFilter(id) {
  const d = getBlock(id);
  return d.opaque ? 15 : d.filter;
}

// ---------------------------------------------------------------------------
// Texture resolution
// ---------------------------------------------------------------------------

// index by FACE_* constant: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east
const FACE_KEYS = ['bottom', 'top', 'north', 'south', 'west', 'east'];

/**
 * Resolves the atlas texture NAME for one face of a block.
 * Handles the per-model conventions: column axis swapping, crop growth stages,
 * door halves, and front-facing / lit machines.
 */
export function getTexture(id, meta = 0, face = FACE_UP) {
  const def = getBlock(id);
  const m = meta & 15;
  let f = face | 0;
  if (f < 0 || f > 5) f = FACE_UP;

  // 'column' stores the axis in meta: 0 = y, 1 = x, 2 = z. Rotating the axis
  // moves the end-cap texture onto a different pair of faces.
  if (def.model === 'column') {
    const axis = m & 3;
    const end = axis === 1 ? (f === 4 || f === 5) : axis === 2 ? (f === 2 || f === 3) : (f === 0 || f === 1);
    f = end ? FACE_UP : FACE_NORTH;
  }

  const t = def.tex;
  let name;
  if (typeof t === 'string') {
    name = t;
  } else if (t && typeof t === 'object') {
    const key = FACE_KEYS[f];
    name = t[key];
    if (name === undefined && (f === 0 || f === 1)) name = t.end;
    if (name === undefined && f === 0) name = t.top;
    if (name === undefined && f > 1) name = t.side;
    if (name === undefined) name = t.all;
    if (name === undefined) name = t.side;
    if (name === undefined) name = t.top;
    if (name === undefined) name = def.name;

    // Front-facing machines: furnaces, dispensers, observers, pumpkins...
    if (t.front !== undefined) {
      const facing = HFACE_TO_FACE[m & 3];
      if (f === facing) name = t.front;
      else if (t.back !== undefined && f === FACE_OPPOSITE[facing]) name = t.back;
    }
  } else {
    name = def.name;
  }

  switch (def.model) {
    case 'crop':
      return name + '_stage' + (m & 7);
    case 'door':
      return name + ((m & 1) ? '_upper' : '_lower');
    default:
      break;
  }

  if (def.litLight !== null || def.litAll) {
    if ((m & def.litBit) !== 0) {
      const frontName = t && typeof t === 'object' ? t.front : undefined;
      if (def.litAll || (frontName !== undefined && name === frontName)) name = name + '_on';
    }
  }
  return name;
}

// ---------------------------------------------------------------------------
// Drop helpers
// ---------------------------------------------------------------------------

const st = (item, count = 1) => ({ item, count, damage: 0 });
const rnd = (rng) => (rng && typeof rng.next === 'function' ? rng.next() : Math.random());
const rint = (rng, min, max) => (min >= max ? min : min + Math.floor(rnd(rng) * (max - min + 1)));

/** Vanilla ore fortune: multiply by 1 + max(0, rand(fortune + 2) - 1). */
function fortuneMul(count, fortune, rng) {
  const f = fortune | 0;
  if (f <= 0) return count;
  let i = Math.floor(rnd(rng) * (f + 2)) - 1;
  if (i < 0) i = 0;
  return count * (i + 1);
}

/** Silk touch drops the block itself, otherwise `item` xN, fortune-multiplied. */
function oreDrops(selfName, item, min = 1, max = 1) {
  return (ctx) => {
    if (ctx && ctx.silkTouch) return [st(selfName)];
    const n = rint(ctx && ctx.rng, min, max);
    return [st(item, fortuneMul(n, ctx ? ctx.fortune : 0, ctx && ctx.rng))];
  };
}

/** Silk touch drops the block itself, otherwise `item` xN with no fortune bonus. */
function silkOrItem(selfName, item, min = 1, max = 1, fortuneCap = 0) {
  return (ctx) => {
    if (ctx && ctx.silkTouch) return [st(selfName)];
    let n = rint(ctx && ctx.rng, min, max);
    if (fortuneCap) n = Math.min(fortuneCap, n + Math.floor(rnd(ctx && ctx.rng) * ((ctx && ctx.fortune) | 0 ? ((ctx.fortune | 0) + 1) : 1)));
    return [st(item, n)];
  };
}

/** Silk touch drops the block, anything else drops nothing (glass, ice, spawners). */
function silkOnly(selfName) {
  return (ctx) => (ctx && ctx.silkTouch ? [st(selfName)] : []);
}

/** Leaves: sapling 5%, stick 2%, apple 0.5% (oak/dark oak). Shears/silk keep the leaves. */
function leavesDrops(selfName, sapling, apple) {
  return (ctx) => {
    if (ctx && (ctx.silkTouch || ctx.tool === 'shears')) return [st(selfName)];
    const fortune = ctx ? (ctx.fortune | 0) : 0;
    const rng = ctx && ctx.rng;
    const out = [];
    const sapChance = [0.05, 0.0625, 0.0833, 0.1][Math.min(3, fortune)];
    if (sapling && rnd(rng) < sapChance) out.push(st(sapling));
    const stickChance = [0.02, 0.022, 0.025, 0.033][Math.min(3, fortune)];
    if (rnd(rng) < stickChance) out.push(st('stick', 1 + Math.floor(rnd(rng) * 2)));
    if (apple && rnd(rng) < [0.005, 0.00556, 0.00625, 0.00833][Math.min(3, fortune)]) out.push(st('apple'));
    return out;
  };
}

/** Gravel: 10% flint (rises with fortune), otherwise gravel. */
function gravelDrops(ctx) {
  if (ctx && ctx.silkTouch) return [st('gravel')];
  const fortune = ctx ? (ctx.fortune | 0) : 0;
  const chance = [0.1, 0.14, 0.25, 1][Math.min(3, fortune)];
  return rnd(ctx && ctx.rng) < chance ? [st('flint')] : [st('gravel')];
}

/** Grass / ferns drop wheat seeds 12.5% of the time unless sheared. */
function grassDrops(selfName, seed = 'wheat_seeds') {
  return (ctx) => {
    if (ctx && (ctx.silkTouch || ctx.tool === 'shears')) return [st(selfName)];
    const fortune = ctx ? (ctx.fortune | 0) : 0;
    return rnd(ctx && ctx.rng) < 0.125 + fortune * 0.03 ? [st(seed)] : [];
  };
}

/** Crops drop their product plus 0..3 seeds, only when fully grown. */
function cropDrops(seedItem, product, minProduct = 1, maxProduct = 1, ripe = 7) {
  return (ctx) => {
    const meta = ctx ? (ctx.meta | 0) : 0;
    if ((meta & 7) < ripe) return [st(seedItem)];
    const fortune = ctx ? (ctx.fortune | 0) : 0;
    const out = [st(product, rint(ctx && ctx.rng, minProduct, maxProduct) + (fortune > 0 ? Math.floor(rnd(ctx && ctx.rng) * (fortune + 1)) : 0))];
    let seeds = 0;
    for (let i = 0; i < 3 + fortune; i++) if (rnd(ctx && ctx.rng) < 0.5714) seeds++;
    if (seeds > 0 && seedItem !== product) out.push(st(seedItem, seeds));
    return out;
  };
}

// ---------------------------------------------------------------------------
// Family generators
// ---------------------------------------------------------------------------

/** 'stone_bricks' -> 'stone_brick', 'quartz_block' -> 'quartz'. */
function stemOf(name) {
  if (name.endsWith('_block')) return name.slice(0, -6);
  if (name.endsWith('bricks') || name.endsWith('tiles')) return name.slice(0, -1);
  return name;
}

/**
 * Registers a stone-like block plus the usual stairs / slab / wall companions.
 * `opts.base:false` skips the base block (used when it is defined by hand).
 */
function defineStoneSet(name, opts = {}) {
  const {
    hardness = 1.5, resistance = 6, tool = 'pickaxe', tier = 0, requiresTool = true,
    sound = 'stone', light = 0, group = 'building', model = 'cube', tex = null,
    stairs = true, slab = true, wall = false, base = true, drops = undefined,
    stem = null, gravity = false, tint = null,
  } = opts;
  const common = { hardness, resistance, tool, tier, requiresTool, sound, light, group, gravity, tint };
  const t = tex || name;
  if (base) defineBlock(name, { ...common, model, tex: t, drops });
  const s = stem || stemOf(name);
  if (stairs) {
    defineBlock(s + '_stairs', { ...common, model: 'stairs', tex: t, opaque: false, filter: 0, collision: 'full', renderPass: 'opaque' });
  }
  if (slab) {
    defineBlock(s + '_slab', { ...common, model: 'slab', tex: t, opaque: false, filter: 0, collision: 'half', renderPass: 'opaque' });
  }
  if (wall) {
    defineBlock(s + '_wall', { ...common, model: 'wall', tex: t, opaque: false, filter: 0, collision: 'full', renderPass: 'opaque' });
  }
}

/**
 * Registers a whole wood family: log, stripped log, wood, stripped wood, planks,
 * stairs, slab, fence, fence gate, door, trapdoor, button, pressure plate,
 * signs, leaves and sapling. Pass `null` for any member the family lacks.
 */
function defineWoodSet(name, opts = {}) {
  const o = {
    log: name + '_log',
    strippedLog: 'stripped_' + name + '_log',
    wood: name + '_wood',
    strippedWood: 'stripped_' + name + '_wood',
    planks: name + '_planks',
    leaves: name + '_leaves',
    sapling: name + '_sapling',
    logHardness: 2,
    flammable: 5,
    leafFlammable: 30,
    leafTint: 'foliage',
    apple: false,
    saplingDrop: null,
    hangingSign: true,
    group: 'building',
    ...opts,
  };
  const wood = { sound: 'wood', tool: 'axe', group: o.group, flammable: o.flammable };

  if (o.log) {
    defineBlock(o.log, {
      ...wood, model: 'column', tex: { top: o.log + '_top', side: o.log },
      hardness: o.logHardness, resistance: 2, burnTime: 300,
    });
  }
  if (o.strippedLog) {
    defineBlock(o.strippedLog, {
      ...wood, model: 'column', tex: { top: o.strippedLog + '_top', side: o.strippedLog },
      hardness: o.logHardness, resistance: 2, burnTime: 300,
    });
  }
  if (o.wood) {
    defineBlock(o.wood, { ...wood, model: 'column', tex: { all: o.log }, hardness: o.logHardness, resistance: 2, burnTime: 300 });
  }
  if (o.strippedWood) {
    defineBlock(o.strippedWood, { ...wood, model: 'column', tex: { all: o.strippedLog }, hardness: o.logHardness, resistance: 2, burnTime: 300 });
  }

  const p = o.planks;
  defineBlock(p, { ...wood, hardness: 2, resistance: 3, burnTime: 300 });
  defineBlock(name + '_stairs', { ...wood, model: 'stairs', tex: p, hardness: 2, resistance: 3, burnTime: 300, opaque: false, filter: 0, collision: 'full', renderPass: 'opaque' });
  defineBlock(name + '_slab', { ...wood, model: 'slab', tex: p, hardness: 2, resistance: 3, burnTime: 150, opaque: false, filter: 0, collision: 'half', renderPass: 'opaque' });
  defineBlock(name + '_fence', { ...wood, model: 'fence', tex: p, hardness: 2, resistance: 3, burnTime: 300, opaque: false, filter: 0, collision: 'full', renderPass: 'opaque' });
  defineBlock(name + '_fence_gate', { ...wood, model: 'fence_gate', tex: p, hardness: 2, resistance: 3, burnTime: 300, opaque: false, filter: 0, collision: 'full', renderPass: 'opaque' });
  defineBlock(name + '_door', {
    ...wood, model: 'door', tex: name + '_door', hardness: 3, resistance: 3, burnTime: 200,
    opaque: false, filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 1, 0.1875]], group: 'redstone',
  });
  defineBlock(name + '_trapdoor', {
    ...wood, model: 'trapdoor', tex: name + '_trapdoor', hardness: 3, resistance: 3, burnTime: 300,
    opaque: false, filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.1875, 1]], group: 'redstone',
  });
  defineBlock(name + '_button', {
    ...wood, model: 'button', tex: p, hardness: 0.5, resistance: 0.5, burnTime: 100,
    solid: false, opaque: false, filter: 0, collision: 'none', group: 'redstone', renderPass: 'cutout',
  });
  defineBlock(name + '_pressure_plate', {
    ...wood, model: 'flat', tex: p, hardness: 0.5, resistance: 0.5, burnTime: 300,
    solid: false, opaque: false, filter: 0, collision: 'none', group: 'redstone', renderPass: 'cutout',
  });
  defineBlock(name + '_sign', {
    ...wood, model: 'sign', tex: p, hardness: 1, resistance: 1, burnTime: 200, entityType: 'sign',
    solid: false, opaque: false, filter: 0, collision: 'none', group: 'decoration', renderPass: 'cutout',
  });
  defineBlock(name + '_wall_sign', {
    ...wood, model: 'wall_sign', tex: p, hardness: 1, resistance: 1, burnTime: 200, entityType: 'sign',
    solid: false, opaque: false, filter: 0, collision: 'none', group: 'decoration', renderPass: 'cutout',
    drops: name + '_sign', itemName: name + '_sign',
  });
  if (o.hangingSign) {
    defineBlock(name + '_hanging_sign', {
      ...wood, model: 'sign', tex: p, hardness: 1, resistance: 1, burnTime: 200, entityType: 'sign',
      solid: false, opaque: false, filter: 0, collision: 'none', group: 'decoration', renderPass: 'cutout',
    });
    defineBlock(name + '_wall_hanging_sign', {
      ...wood, model: 'wall_sign', tex: p, hardness: 1, resistance: 1, burnTime: 200, entityType: 'sign',
      solid: false, opaque: false, filter: 0, collision: 'none', group: 'decoration', renderPass: 'cutout',
      drops: name + '_hanging_sign', itemName: name + '_hanging_sign',
    });
  }
  if (o.leaves) {
    defineBlock(o.leaves, {
      model: 'cube', tex: o.leaves, tint: o.leafTint, renderPass: 'cutout',
      opaque: false, filter: 1, hardness: 0.2, resistance: 0.2, tool: 'hoe',
      sound: 'grass', flammable: o.leafFlammable, ticksRandomly: true, group: 'decoration',
      drops: leavesDrops(o.leaves, o.saplingDrop || o.sapling, o.apple),
    });
  }
  if (o.sapling) {
    defineBlock(o.sapling, {
      model: 'cross', tex: o.sapling, solid: false, opaque: false, filter: 0, collision: 'none',
      hardness: 0, resistance: 0, sound: 'grass', renderPass: 'cutout', ticksRandomly: true,
      burnTime: 100, group: 'decoration',
    });
  }
}

/** Standard Minecraft dye order. */
const COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];
const COLOR_HEX = {
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da,
  yellow: 0xfed83d, lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52,
  light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};

/**
 * Registers the 16 dyed variants of a block family (`<color>_<base>`).
 * `props` may be a plain object or a function (color, name) -> props.
 */
function defineColorSet(base, props = {}) {
  for (const c of COLORS) {
    const name = c + '_' + base;
    const p = typeof props === 'function' ? props(c, name) : { ...props };
    defineBlock(name, p);
  }
}

/** Registers `<name>_ore` and `deepslate_<name>_ore`. */
function defineOre(name, opts = {}) {
  const {
    item = name, min = 1, max = 1, tier = 0, xp = null, light = 0,
    hardness = 3, resistance = 3, deepslate = true, fortune = true,
  } = opts;
  const oreName = name + '_ore';
  const mk = (n, h) => defineBlock(n, {
    hardness: h, resistance, tool: 'pickaxe', tier, requiresTool: true, light,
    litLight: light ? light : null, litBit: 8, tex: n, xp,
    drops: fortune ? oreDrops(n, item, min, max) : silkOrItem(n, item, min, max),
    ticksRandomly: !!light, group: 'building',
  });
  mk(oreName, hardness);
  if (deepslate) mk('deepslate_' + name + '_ore', hardness + 1.5);
}

// ===========================================================================
// 1. Air and technical blocks
// ===========================================================================
const AIR_PROPS = {
  model: 'none', tex: 'air', solid: false, opaque: false, filter: 0, collision: 'none',
  replaceable: true, hardness: -1, resistance: 0, drops: null, renderPass: 'cutout',
  group: 'misc', itemName: 'air',
};
defineBlock('air', AIR_PROPS);
defineBlock('stone', {
  hardness: 1.5, resistance: 6, tool: 'pickaxe', tier: 0, requiresTool: true,
  drops: (ctx) => [st(ctx && ctx.silkTouch ? 'stone' : 'cobblestone')],
});
defineStoneSet('stone', { base: false, hardness: 1.5, resistance: 6, wall: false });
defineBlock('cave_air', AIR_PROPS);
defineBlock('void_air', AIR_PROPS);
defineBlock('barrier', {
  model: 'none', tex: 'barrier', solid: true, opaque: false, filter: 0, collision: 'full',
  hardness: -1, resistance: 3600000, drops: null, group: 'misc', renderPass: 'cutout',
});
defineBlock('structure_void', {
  model: 'none', tex: 'structure_void', solid: false, opaque: false, filter: 0,
  collision: 'none', replaceable: true, hardness: -1, resistance: 0, drops: null, group: 'misc',
});
defineBlock('light', {
  model: 'none', tex: 'light', solid: false, opaque: false, filter: 0, collision: 'none',
  replaceable: true, hardness: -1, resistance: 0, light: 15, drops: null, group: 'misc',
});
defineBlock('moving_piston', {
  model: 'none', tex: 'piston_side', solid: false, opaque: false, filter: 0,
  collision: 'none', hardness: -1, resistance: 0, drops: null, group: 'redstone',
});

// ---- Fluids ---------------------------------------------------------------
defineBlock('water', {
  model: 'fluid', tex: 'water_still', flowTex: 'water_flow', tint: 'water',
  renderPass: 'translucent', liquid: 'water', solid: false, opaque: false, filter: 1,
  replaceable: true, hardness: 100, resistance: 100, collision: 'none', drops: null,
  group: 'misc', itemName: 'water_bucket',
});
alias('flowing_water', 'water');
defineBlock('lava', {
  model: 'fluid', tex: 'lava_still', flowTex: 'lava_flow', renderPass: 'opaque',
  liquid: 'lava', solid: false, opaque: false, filter: 0, light: 15,
  replaceable: true, hardness: 100, resistance: 100, collision: 'none', drops: null,
  group: 'misc', itemName: 'lava_bucket',
});
alias('flowing_lava', 'lava');
defineBlock('bubble_column', {
  model: 'fluid', tex: 'water_still', tint: 'water', renderPass: 'translucent',
  liquid: 'water', solid: false, opaque: false, filter: 1, replaceable: true,
  hardness: 100, resistance: 100, collision: 'none', drops: null, group: 'misc',
});
defineBlock('fire', {
  model: 'cross', tex: 'fire_0', solid: false, opaque: false, filter: 0, collision: 'none',
  light: 15, hardness: 0, resistance: 0, replaceable: true, ticksRandomly: true,
  drops: null, renderPass: 'cutout', group: 'misc', sound: 'wool',
});
defineBlock('soul_fire', {
  model: 'cross', tex: 'soul_fire_0', solid: false, opaque: false, filter: 0, collision: 'none',
  light: 10, hardness: 0, resistance: 0, replaceable: true, ticksRandomly: true,
  drops: null, renderPass: 'cutout', group: 'misc', sound: 'wool',
});

// ===========================================================================
// 2. Stone family
// ===========================================================================
defineBlock('bedrock', {
  hardness: -1, resistance: 3600000, tool: 'pickaxe', drops: null, group: 'building',
});
defineStoneSet('granite', { wall: true });
defineStoneSet('polished_granite', {});
defineStoneSet('diorite', { wall: true });
defineStoneSet('polished_diorite', {});
defineStoneSet('andesite', { wall: true });
defineStoneSet('polished_andesite', {});
defineStoneSet('cobblestone', { hardness: 2, wall: true });
defineStoneSet('mossy_cobblestone', { hardness: 2, wall: true });
defineStoneSet('smooth_stone', { hardness: 2, stairs: false, tex: { top: 'smooth_stone', bottom: 'smooth_stone', side: 'smooth_stone_slab_side' } });
defineStoneSet('stone_bricks', { wall: true });
defineStoneSet('mossy_stone_bricks', { wall: true });
defineBlock('cracked_stone_bricks', { hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('chiseled_stone_bricks', { hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineStoneSet('bricks', { hardness: 2, wall: true });
defineBlock('cobblestone_wall_gate', { model: 'fence_gate', tex: 'cobblestone', hardness: 2, resistance: 6, tool: 'pickaxe', requiresTool: true, opaque: false, filter: 0, renderPass: 'opaque' });

// Deepslate
defineBlock('deepslate', {
  model: 'column', tex: { top: 'deepslate_top', side: 'deepslate' },
  hardness: 3, resistance: 6, tool: 'pickaxe', requiresTool: true,
  drops: (ctx) => [st(ctx && ctx.silkTouch ? 'deepslate' : 'cobbled_deepslate')],
});
defineStoneSet('cobbled_deepslate', { hardness: 3.5, wall: true });
defineStoneSet('polished_deepslate', { hardness: 3.5, wall: true });
defineStoneSet('deepslate_bricks', { hardness: 3.5, wall: true });
defineStoneSet('deepslate_tiles', { hardness: 3.5, wall: true });
defineBlock('cracked_deepslate_bricks', { hardness: 3.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('cracked_deepslate_tiles', { hardness: 3.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('chiseled_deepslate', { hardness: 3.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('reinforced_deepslate', { hardness: 55, resistance: 1200, tool: 'pickaxe', drops: null, tex: { top: 'reinforced_deepslate_top', bottom: 'reinforced_deepslate_bottom', side: 'reinforced_deepslate_side' } });

defineBlock('tuff', { hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('calcite', { hardness: 0.75, resistance: 0.75, tool: 'pickaxe', requiresTool: true });
defineBlock('dripstone_block', { hardness: 1.5, resistance: 1, tool: 'pickaxe', requiresTool: true });
defineBlock('pointed_dripstone', {
  model: 'cross', tex: 'pointed_dripstone_up_tip', hardness: 1.5, resistance: 3, tool: 'pickaxe',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
});

// Blackstone / basalt
defineStoneSet('blackstone', { tex: { top: 'blackstone_top', bottom: 'blackstone_top', side: 'blackstone' }, wall: true });
defineStoneSet('polished_blackstone', { hardness: 2, wall: true });
defineStoneSet('polished_blackstone_bricks', { wall: true });
defineBlock('cracked_polished_blackstone_bricks', { hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('chiseled_polished_blackstone', { hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('gilded_blackstone', {
  hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true,
  drops: (ctx) => {
    if (ctx && ctx.silkTouch) return [st('gilded_blackstone')];
    if (rnd(ctx && ctx.rng) < 0.1) return [st('gilded_blackstone')];
    return [st('gold_nugget', rint(ctx && ctx.rng, 2, 5))];
  },
});
defineBlock('basalt', { model: 'column', tex: { top: 'basalt_top', side: 'basalt_side' }, hardness: 1.25, resistance: 4.2, tool: 'pickaxe', requiresTool: true });
defineBlock('polished_basalt', { model: 'column', tex: { top: 'polished_basalt_top', side: 'polished_basalt_side' }, hardness: 1.25, resistance: 4.2, tool: 'pickaxe', requiresTool: true });
defineBlock('smooth_basalt', { hardness: 1.25, resistance: 4.2, tool: 'pickaxe', requiresTool: true });

defineBlock('obsidian', { hardness: 50, resistance: 1200, tool: 'pickaxe', tier: 3, requiresTool: true });
defineBlock('crying_obsidian', { hardness: 50, resistance: 1200, tool: 'pickaxe', tier: 3, requiresTool: true, light: 10 });

// Nether stone
defineBlock('netherrack', { hardness: 0.4, resistance: 0.4, tool: 'pickaxe', requiresTool: true, sound: 'stone', group: 'building' });
defineStoneSet('nether_bricks', { hardness: 2, resistance: 6, wall: true });
defineStoneSet('red_nether_bricks', { hardness: 2, resistance: 6, wall: true });
defineBlock('cracked_nether_bricks', { hardness: 2, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('chiseled_nether_bricks', { hardness: 2, resistance: 6, tool: 'pickaxe', requiresTool: true });
defineBlock('nether_brick_fence', {
  model: 'fence', tex: 'nether_bricks', hardness: 2, resistance: 6, tool: 'pickaxe',
  requiresTool: true, opaque: false, filter: 0, renderPass: 'opaque', collision: 'full',
});
defineBlock('nether_wart_block', { hardness: 1, resistance: 1, tool: 'hoe', sound: 'wool', group: 'building' });
defineBlock('warped_wart_block', { hardness: 1, resistance: 1, tool: 'hoe', sound: 'wool', group: 'building' });
defineBlock('crimson_nylium', {
  tex: { top: 'crimson_nylium', bottom: 'netherrack', side: 'crimson_nylium_side' },
  hardness: 0.4, resistance: 0.4, tool: 'pickaxe', requiresTool: true, ticksRandomly: true,
  drops: (ctx) => [st(ctx && ctx.silkTouch ? 'crimson_nylium' : 'netherrack')],
});
defineBlock('warped_nylium', {
  tex: { top: 'warped_nylium', bottom: 'netherrack', side: 'warped_nylium_side' },
  hardness: 0.4, resistance: 0.4, tool: 'pickaxe', requiresTool: true, ticksRandomly: true,
  drops: (ctx) => [st(ctx && ctx.silkTouch ? 'warped_nylium' : 'netherrack')],
});

// End stone / purpur
defineBlock('end_stone', { hardness: 3, resistance: 9, tool: 'pickaxe', requiresTool: true });
defineStoneSet('end_stone_bricks', { hardness: 3, resistance: 9, wall: true });
defineStoneSet('purpur_block', { hardness: 1.5, resistance: 6 });
defineBlock('purpur_pillar', { model: 'column', tex: { top: 'purpur_pillar_top', side: 'purpur_pillar' }, hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true });

// Prismarine
defineStoneSet('prismarine', { hardness: 1.5, resistance: 6, wall: true });
defineStoneSet('prismarine_bricks', { hardness: 1.5, resistance: 6 });
defineStoneSet('dark_prismarine', { hardness: 1.5, resistance: 6 });
defineBlock('sea_lantern', {
  hardness: 0.3, resistance: 0.3, light: 15, sound: 'glass', group: 'building',
  drops: silkOrItem('sea_lantern', 'prismarine_crystals', 2, 3, 5),
});

// Quartz
defineStoneSet('quartz_block', { hardness: 0.8, resistance: 0.8, tex: { top: 'quartz_block_top', bottom: 'quartz_block_bottom', side: 'quartz_block_side' } });
defineStoneSet('smooth_quartz', { hardness: 0.8, resistance: 0.8, tex: 'quartz_block_bottom' });
defineBlock('chiseled_quartz_block', { model: 'column', tex: { top: 'chiseled_quartz_block_top', side: 'chiseled_quartz_block' }, hardness: 0.8, resistance: 0.8, tool: 'pickaxe', requiresTool: true });
defineBlock('quartz_pillar', { model: 'column', tex: { top: 'quartz_pillar_top', side: 'quartz_pillar' }, hardness: 0.8, resistance: 0.8, tool: 'pickaxe', requiresTool: true });
defineBlock('quartz_bricks', { hardness: 0.8, resistance: 0.8, tool: 'pickaxe', requiresTool: true });

// Misc nether / light stone
defineBlock('magma_block', { hardness: 0.5, resistance: 0.5, tool: 'pickaxe', requiresTool: true, light: 3 });
defineBlock('soul_sand', {
  hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'sand',
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.875, 1]],
});
defineBlock('soul_soil', { hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'sand' });
defineBlock('glowstone', {
  hardness: 0.3, resistance: 0.3, light: 15, sound: 'glass', group: 'building',
  drops: silkOrItem('glowstone', 'glowstone_dust', 2, 4, 4),
});
defineBlock('shroomlight', { hardness: 1, resistance: 1, light: 15, tool: 'hoe', sound: 'grass', group: 'building' });
defineBlock('ochre_froglight', { model: 'column', tex: { top: 'ochre_froglight_top', side: 'ochre_froglight_side' }, hardness: 0.3, resistance: 0.3, light: 15, sound: 'wool' });
defineBlock('verdant_froglight', { model: 'column', tex: { top: 'verdant_froglight_top', side: 'verdant_froglight_side' }, hardness: 0.3, resistance: 0.3, light: 15, sound: 'wool' });
defineBlock('pearlescent_froglight', { model: 'column', tex: { top: 'pearlescent_froglight_top', side: 'pearlescent_froglight_side' }, hardness: 0.3, resistance: 0.3, light: 15, sound: 'wool' });

// Amethyst
defineBlock('amethyst_block', { hardness: 1.5, resistance: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'glass' });
defineBlock('budding_amethyst', { hardness: 1.5, resistance: 1.5, tool: 'pickaxe', requiresTool: true, sound: 'glass', ticksRandomly: true, drops: null });
const budProps = (n, lightLevel) => ({
  model: 'cross', tex: n, solid: false, opaque: false, filter: 0, collision: 'none',
  hardness: 1.5, resistance: 1.5, tool: 'pickaxe', sound: 'glass', light: lightLevel,
  renderPass: 'cutout', group: 'decoration',
});
defineBlock('small_amethyst_bud', { ...budProps('small_amethyst_bud', 1), drops: null });
defineBlock('medium_amethyst_bud', { ...budProps('medium_amethyst_bud', 2), drops: null });
defineBlock('large_amethyst_bud', { ...budProps('large_amethyst_bud', 4), drops: null });
defineBlock('amethyst_cluster', {
  ...budProps('amethyst_cluster', 5),
  drops: (ctx) => {
    if (ctx && ctx.silkTouch) return [st('amethyst_cluster')];
    const base = ctx && ctx.tool === 'pickaxe' ? 4 : 2;
    return [st('amethyst_shard', fortuneMul(base, ctx ? ctx.fortune : 0, ctx && ctx.rng))];
  },
});

// Mud & moss
defineBlock('mud', { hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'gravel' });
defineBlock('packed_mud', { hardness: 1, resistance: 3, tool: 'pickaxe' });
defineStoneSet('mud_bricks', { hardness: 1.5, resistance: 3, wall: true });
defineBlock('moss_block', { hardness: 0.1, resistance: 0.1, tool: 'hoe', sound: 'grass', group: 'decoration' });
defineBlock('moss_carpet', {
  model: 'carpet', tex: 'moss_block', hardness: 0.1, resistance: 0.1, tool: 'hoe', sound: 'grass',
  opaque: false, filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.0625, 1]],
  renderPass: 'opaque', group: 'decoration',
});

// Infested (silverfish) stone
for (const [inf, host] of [
  ['infested_stone', 'stone'], ['infested_cobblestone', 'cobblestone'],
  ['infested_stone_bricks', 'stone_bricks'], ['infested_mossy_stone_bricks', 'mossy_stone_bricks'],
  ['infested_cracked_stone_bricks', 'cracked_stone_bricks'],
  ['infested_chiseled_stone_bricks', 'chiseled_stone_bricks'], ['infested_deepslate', 'deepslate'],
]) {
  defineBlock(inf, {
    tex: host === 'deepslate' ? { top: 'deepslate_top', side: 'deepslate' } : host,
    model: host === 'deepslate' ? 'column' : 'cube',
    hardness: 0.75, resistance: 0.75, tool: 'pickaxe', drops: null, group: 'misc',
  });
}

// ===========================================================================
// 3. Dirt, sand, snow and ice
// ===========================================================================
defineBlock('dirt', { hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'gravel' });
defineBlock('coarse_dirt', { hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'gravel' });
defineBlock('rooted_dirt', { hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'gravel' });
defineBlock('grass_block', {
  tex: { top: 'grass_block_top', bottom: 'dirt', side: 'grass_block_side' },
  overlay: 'grass_block_side_overlay', tint: 'grass', tintFaces: [1],
  hardness: 0.6, resistance: 0.6, tool: 'shovel', sound: 'grass', ticksRandomly: true,
  drops: (ctx) => [st(ctx && ctx.silkTouch ? 'grass_block' : 'dirt')],
});
defineBlock('podzol', {
  tex: { top: 'podzol_top', bottom: 'dirt', side: 'podzol_side' },
  hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'grass',
  drops: (ctx) => [st(ctx && ctx.silkTouch ? 'podzol' : 'dirt')],
});
defineBlock('mycelium', {
  tex: { top: 'mycelium_top', bottom: 'dirt', side: 'mycelium_side' },
  hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'grass', ticksRandomly: true,
  drops: (ctx) => [st(ctx && ctx.silkTouch ? 'mycelium' : 'dirt')],
});
defineBlock('farmland', {
  model: 'farmland', tex: { top: 'farmland', bottom: 'dirt', side: 'dirt' },
  hardness: 0.6, resistance: 0.6, tool: 'shovel', sound: 'gravel', ticksRandomly: true,
  opaque: false, filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.9375, 1]],
  renderPass: 'opaque', drops: 'dirt', itemName: 'dirt',
});
defineBlock('dirt_path', {
  model: 'path', tex: { top: 'dirt_path_top', bottom: 'dirt', side: 'dirt_path_side' },
  hardness: 0.65, resistance: 0.65, tool: 'shovel', sound: 'grass',
  opaque: false, filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.9375, 1]],
  renderPass: 'opaque', drops: 'dirt', itemName: 'dirt',
});
defineBlock('sand', { hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'sand', gravity: true });
defineBlock('red_sand', { hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'sand', gravity: true });
defineBlock('suspicious_sand', { hardness: 0.25, resistance: 0.25, tool: 'shovel', sound: 'sand', gravity: true, drops: 'sand', group: 'misc' });
defineBlock('suspicious_gravel', { hardness: 0.25, resistance: 0.25, tool: 'shovel', sound: 'gravel', gravity: true, drops: 'gravel', group: 'misc' });
defineBlock('gravel', { hardness: 0.6, resistance: 0.6, tool: 'shovel', sound: 'gravel', gravity: true, drops: gravelDrops });
defineBlock('clay', {
  hardness: 0.6, resistance: 0.6, tool: 'shovel', sound: 'gravel',
  drops: silkOrItem('clay', 'clay_ball', 4, 4),
});

defineStoneSet('sandstone', { hardness: 0.8, resistance: 0.8, wall: true, tex: { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone' } });
defineStoneSet('cut_sandstone', { hardness: 0.8, resistance: 0.8, stairs: false, tex: { top: 'sandstone_top', bottom: 'sandstone_top', side: 'cut_sandstone' } });
defineStoneSet('smooth_sandstone', { hardness: 0.8, resistance: 0.8, tex: 'sandstone_top' });
defineBlock('chiseled_sandstone', { hardness: 0.8, resistance: 0.8, tool: 'pickaxe', requiresTool: true, tex: { top: 'sandstone_top', bottom: 'sandstone_top', side: 'chiseled_sandstone' } });
defineStoneSet('red_sandstone', { hardness: 0.8, resistance: 0.8, wall: true, tex: { top: 'red_sandstone_top', bottom: 'red_sandstone_bottom', side: 'red_sandstone' } });
defineStoneSet('cut_red_sandstone', { hardness: 0.8, resistance: 0.8, stairs: false, tex: { top: 'red_sandstone_top', bottom: 'red_sandstone_top', side: 'cut_red_sandstone' } });
defineStoneSet('smooth_red_sandstone', { hardness: 0.8, resistance: 0.8, tex: 'red_sandstone_top' });
defineBlock('chiseled_red_sandstone', { hardness: 0.8, resistance: 0.8, tool: 'pickaxe', requiresTool: true, tex: { top: 'red_sandstone_top', bottom: 'red_sandstone_top', side: 'chiseled_red_sandstone' } });

defineBlock('snow_block', {
  hardness: 0.2, resistance: 0.2, tool: 'shovel', requiresTool: true, sound: 'snow',
  drops: silkOrItem('snow_block', 'snowball', 4, 4),
});
defineBlock('snow', {
  model: 'layer', tex: 'snow', hardness: 0.1, resistance: 0.1, tool: 'shovel', requiresTool: true,
  sound: 'snow', opaque: false, filter: 0, replaceable: true, ticksRandomly: true,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.125, 1]], renderPass: 'opaque', group: 'decoration',
  drops: (ctx) => (ctx && ctx.silkTouch ? [st('snow')] : [st('snowball', 1 + ((ctx ? ctx.meta | 0 : 0) & 7))]),
});
defineBlock('powder_snow', {
  tex: 'powder_snow', hardness: 0.25, resistance: 0.25, sound: 'snow', solid: false,
  collision: 'none', opaque: true, drops: null, group: 'misc', itemName: 'powder_snow_bucket',
});
defineBlock('ice', {
  hardness: 0.5, resistance: 0.5, tool: 'pickaxe', sound: 'glass', slipperiness: 0.98,
  opaque: false, filter: 3, renderPass: 'translucent', ticksRandomly: true, drops: silkOnly('ice'),
});
defineBlock('packed_ice', {
  hardness: 0.5, resistance: 0.5, tool: 'pickaxe', sound: 'glass', slipperiness: 0.98,
  drops: silkOnly('packed_ice'),
});
defineBlock('blue_ice', {
  hardness: 2.8, resistance: 2.8, tool: 'pickaxe', sound: 'glass', slipperiness: 0.989,
  drops: silkOnly('blue_ice'),
});
defineBlock('frosted_ice', {
  tex: 'frosted_ice_0', hardness: 0.5, resistance: 0.5, tool: 'pickaxe', sound: 'glass',
  slipperiness: 0.98, opaque: false, filter: 3, renderPass: 'translucent',
  ticksRandomly: true, drops: null, group: 'misc',
});

// Terracotta (base + 16 colours) and glazed terracotta
defineBlock('terracotta', { hardness: 1.25, resistance: 4.2, tool: 'pickaxe', requiresTool: true });
defineColorSet('terracotta', (c) => ({ hardness: 1.25, resistance: 4.2, tool: 'pickaxe', requiresTool: true, tint: null, display: prettyName(c + '_terracotta') }));
defineColorSet('glazed_terracotta', () => ({ hardness: 1.4, resistance: 1.4, tool: 'pickaxe', requiresTool: true }));

// ===========================================================================
// 4. Ores and mineral blocks
// ===========================================================================
defineOre('coal', { item: 'coal', tier: 0, xp: [0, 2] });
defineOre('iron', { item: 'raw_iron', tier: 1, fortune: false });
defineOre('copper', { item: 'raw_copper', min: 2, max: 3, tier: 1 });
defineOre('gold', { item: 'raw_gold', tier: 2, fortune: false });
defineOre('redstone', { item: 'redstone', min: 4, max: 5, tier: 2, light: 9, xp: [1, 5] });
defineOre('lapis', { item: 'lapis_lazuli', min: 4, max: 9, tier: 1, xp: [2, 5] });
defineOre('diamond', { item: 'diamond', tier: 2, xp: [3, 7] });
defineOre('emerald', { item: 'emerald', tier: 2, xp: [3, 7] });
defineBlock('nether_quartz_ore', {
  hardness: 3, resistance: 3, tool: 'pickaxe', requiresTool: true, xp: [2, 5],
  drops: oreDrops('nether_quartz_ore', 'quartz', 1, 1),
});
defineBlock('nether_gold_ore', {
  hardness: 3, resistance: 3, tool: 'pickaxe', requiresTool: true, xp: [0, 1],
  drops: oreDrops('nether_gold_ore', 'gold_nugget', 2, 6),
});
defineBlock('ancient_debris', { hardness: 30, resistance: 1200, tool: 'pickaxe', tier: 3, requiresTool: true });

defineBlock('coal_block', { hardness: 5, resistance: 6, tool: 'pickaxe', requiresTool: true, burnTime: 16000 });
defineBlock('iron_block', { hardness: 5, resistance: 6, tool: 'pickaxe', tier: 1, requiresTool: true, sound: 'metal' });
defineBlock('gold_block', { hardness: 3, resistance: 6, tool: 'pickaxe', tier: 2, requiresTool: true, sound: 'metal' });
defineBlock('diamond_block', { hardness: 5, resistance: 6, tool: 'pickaxe', tier: 2, requiresTool: true, sound: 'metal' });
defineBlock('emerald_block', { hardness: 5, resistance: 6, tool: 'pickaxe', tier: 2, requiresTool: true, sound: 'metal' });
defineBlock('lapis_block', { hardness: 3, resistance: 3, tool: 'pickaxe', tier: 1, requiresTool: true });
defineBlock('redstone_block', { hardness: 5, resistance: 6, tool: 'pickaxe', tier: 1, requiresTool: true, group: 'redstone' });
defineBlock('netherite_block', { hardness: 50, resistance: 1200, tool: 'pickaxe', tier: 3, requiresTool: true, sound: 'metal' });
defineBlock('raw_iron_block', { hardness: 5, resistance: 6, tool: 'pickaxe', tier: 1, requiresTool: true, sound: 'metal' });
defineBlock('raw_copper_block', { hardness: 5, resistance: 6, tool: 'pickaxe', tier: 1, requiresTool: true, sound: 'metal' });
defineBlock('raw_gold_block', { hardness: 5, resistance: 6, tool: 'pickaxe', tier: 2, requiresTool: true, sound: 'metal' });
defineBlock('bone_block', { model: 'column', tex: { top: 'bone_block_top', side: 'bone_block_side' }, hardness: 2, resistance: 2, tool: 'pickaxe', requiresTool: true });

// Copper: 4 oxidation stages x (plain, cut + stairs + slab) x (raw, waxed)
const COPPER_STAGES = ['', 'exposed_', 'weathered_', 'oxidized_'];
for (const waxed of ['', 'waxed_']) {
  for (const stage of COPPER_STAGES) {
    const plain = waxed + (stage === '' ? 'copper_block' : stage + 'copper');
    const plainTex = stage === '' ? 'copper_block' : stage + 'copper';
    defineBlock(plain, {
      hardness: 3, resistance: 6, tool: 'pickaxe', tier: 1, requiresTool: true,
      sound: 'metal', tex: plainTex, ticksRandomly: waxed === '',
    });
    const cut = waxed + stage + 'cut_copper';
    defineStoneSet(cut, {
      hardness: 3, resistance: 6, tier: 1, sound: 'metal',
      tex: stage + 'cut_copper', stem: cut,
    });
  }
}

// ===========================================================================
// 5. Wood families
// ===========================================================================
defineWoodSet('oak', { apple: true });
defineWoodSet('spruce', { leafTint: 'spruce' });
defineWoodSet('birch', { leafTint: 'birch' });
defineWoodSet('jungle', { });
defineWoodSet('acacia', { });
defineWoodSet('dark_oak', { apple: true });
defineWoodSet('mangrove', { sapling: 'mangrove_propagule' });
defineWoodSet('cherry', { leafTint: null });
defineWoodSet('crimson', {
  log: 'crimson_stem', strippedLog: 'stripped_crimson_stem',
  wood: 'crimson_hyphae', strippedWood: 'stripped_crimson_hyphae',
  leaves: null, sapling: null, flammable: 0,
});
defineWoodSet('warped', {
  log: 'warped_stem', strippedLog: 'stripped_warped_stem',
  wood: 'warped_hyphae', strippedWood: 'stripped_warped_hyphae',
  leaves: null, sapling: null, flammable: 0,
});
defineWoodSet('bamboo', {
  log: 'bamboo_block', strippedLog: 'stripped_bamboo_block',
  wood: null, strippedWood: null, leaves: null, sapling: null,
});
defineBlock('bamboo_mosaic', { sound: 'wood', tool: 'axe', hardness: 2, resistance: 3, flammable: 5, burnTime: 300 });
defineBlock('bamboo_mosaic_stairs', { sound: 'wood', tool: 'axe', tex: 'bamboo_mosaic', model: 'stairs', hardness: 2, resistance: 3, flammable: 5, burnTime: 300, opaque: false, filter: 0, collision: 'full', renderPass: 'opaque' });
defineBlock('bamboo_mosaic_slab', { sound: 'wood', tool: 'axe', tex: 'bamboo_mosaic', model: 'slab', hardness: 2, resistance: 3, flammable: 5, burnTime: 150, opaque: false, filter: 0, collision: 'half', renderPass: 'opaque' });

// Azalea leaves live outside the wood sets (no matching log).
defineBlock('azalea_leaves', {
  tex: 'azalea_leaves', tint: null, renderPass: 'cutout', opaque: false, filter: 1,
  hardness: 0.2, resistance: 0.2, tool: 'hoe', sound: 'grass', flammable: 30,
  ticksRandomly: true, group: 'decoration', drops: leavesDrops('azalea_leaves', 'azalea', false),
});
defineBlock('flowering_azalea_leaves', {
  tex: 'flowering_azalea_leaves', tint: null, renderPass: 'cutout', opaque: false, filter: 1,
  hardness: 0.2, resistance: 0.2, tool: 'hoe', sound: 'grass', flammable: 30,
  ticksRandomly: true, group: 'decoration', drops: leavesDrops('flowering_azalea_leaves', 'flowering_azalea', false),
});

// ===========================================================================
// 6. Coloured sets (16 each)
// ===========================================================================
defineColorSet('wool', (c) => ({
  hardness: 0.8, resistance: 0.8, sound: 'wool', tool: 'shears', flammable: 30,
  burnTime: 100, group: 'building', tint: null, display: prettyName(c + '_wool'),
}));
defineColorSet('carpet', () => ({
  model: 'carpet', hardness: 0.1, resistance: 0.1, sound: 'wool', flammable: 60, burnTime: 67,
  opaque: false, filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.0625, 1]],
  renderPass: 'opaque', group: 'decoration',
}));
defineColorSet('concrete', () => ({ hardness: 1.8, resistance: 1.8, tool: 'pickaxe', requiresTool: true }));
defineColorSet('concrete_powder', () => ({ hardness: 0.5, resistance: 0.5, tool: 'shovel', sound: 'sand', gravity: true }));
defineColorSet('stained_glass', (c) => ({
  hardness: 0.3, resistance: 0.3, sound: 'glass', opaque: false, filter: 0,
  renderPass: 'translucent', group: 'building', drops: silkOnly(c + '_stained_glass'),
}));
defineColorSet('stained_glass_pane', (c) => ({
  model: 'pane', tex: c + '_stained_glass', hardness: 0.3, resistance: 0.3, sound: 'glass',
  opaque: false, filter: 0, renderPass: 'translucent', collision: 'thin',
  group: 'decoration', drops: silkOnly(c + '_stained_glass_pane'),
}));
defineColorSet('bed', (c) => ({
  model: 'bed', tex: c + '_wool', hardness: 0.2, resistance: 0.2, sound: 'wood',
  entityType: 'bed', opaque: false, filter: 0, collision: 'custom',
  boxes: [[0, 0, 0, 1, 0.5625, 1]], renderPass: 'opaque', group: 'decoration', flammable: 30,
}));
defineColorSet('banner', (c) => ({
  model: 'sign', tex: c + '_wool', hardness: 1, resistance: 1, sound: 'wood',
  entityType: 'banner', solid: false, opaque: false, filter: 0, collision: 'none',
  renderPass: 'cutout', group: 'decoration', flammable: 30, burnTime: 300,
}));
defineColorSet('wall_banner', (c) => ({
  model: 'wall_sign', tex: c + '_wool', hardness: 1, resistance: 1, sound: 'wood',
  entityType: 'banner', solid: false, opaque: false, filter: 0, collision: 'none',
  renderPass: 'cutout', group: 'decoration', drops: c + '_banner', itemName: c + '_banner',
}));
defineColorSet('shulker_box', (c) => ({
  hardness: 2, resistance: 2, tool: 'pickaxe', entityType: 'shulker_box',
  opaque: false, filter: 0, renderPass: 'cutout', group: 'decoration',
  tex: { top: c + '_shulker_box_top', bottom: c + '_shulker_box', side: c + '_shulker_box' },
}));
defineColorSet('candle', () => ({
  model: 'cross', hardness: 0.1, resistance: 0.1, sound: 'wool', solid: false, opaque: false,
  filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
  light: 0, litLight: 12, litBit: 8,
}));
defineBlock('shulker_box', {
  hardness: 2, resistance: 2, tool: 'pickaxe', entityType: 'shulker_box',
  opaque: false, filter: 0, renderPass: 'cutout', group: 'decoration',
  tex: { top: 'shulker_box_top', bottom: 'shulker_box', side: 'shulker_box' },
});
defineBlock('candle', {
  model: 'cross', hardness: 0.1, resistance: 0.1, sound: 'wool', solid: false, opaque: false,
  filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
  light: 0, litLight: 12, litBit: 8,
});

// ===========================================================================
// 7. Glass and panes
// ===========================================================================
defineBlock('glass', {
  hardness: 0.3, resistance: 0.3, sound: 'glass', opaque: false, filter: 0,
  renderPass: 'cutout', group: 'building', drops: silkOnly('glass'),
});
defineBlock('tinted_glass', {
  hardness: 0.3, resistance: 0.3, sound: 'glass', opaque: false, filter: 15,
  renderPass: 'translucent', group: 'building',
});
defineBlock('glass_pane', {
  model: 'pane', tex: 'glass', hardness: 0.3, resistance: 0.3, sound: 'glass',
  opaque: false, filter: 0, renderPass: 'cutout', collision: 'thin',
  group: 'decoration', drops: silkOnly('glass_pane'),
});
defineBlock('iron_bars', {
  model: 'pane', tex: 'iron_bars', hardness: 5, resistance: 6, tool: 'pickaxe',
  requiresTool: true, sound: 'metal', opaque: false, filter: 0, renderPass: 'cutout',
  collision: 'thin', group: 'decoration',
});
defineBlock('chain', {
  model: 'end_rod', tex: 'chain', hardness: 5, resistance: 6, tool: 'pickaxe',
  requiresTool: true, sound: 'metal', opaque: false, filter: 0, renderPass: 'cutout',
  collision: 'thin', group: 'decoration',
});

// ===========================================================================
// 8. Plants
// ===========================================================================
/** Small cross-shaped plant with no collision. */
function definePlant(name, opts = {}) {
  return defineBlock(name, {
    model: 'cross', tex: name, solid: false, opaque: false, filter: 0, collision: 'none',
    hardness: 0, resistance: 0, sound: 'grass', renderPass: 'cutout', flammable: 60,
    burnTime: 100, group: 'decoration', ...opts,
  });
}

definePlant('short_grass', { tex: 'short_grass', tint: 'grass', replaceable: true, drops: grassDrops('short_grass') });
alias('grass', 'short_grass');
definePlant('tall_grass', { tint: 'grass', replaceable: true, drops: grassDrops('tall_grass') });
definePlant('fern', { tint: 'grass', replaceable: true, drops: grassDrops('fern') });
definePlant('large_fern', { tint: 'grass', replaceable: true, drops: grassDrops('large_fern') });
definePlant('dead_bush', { replaceable: true, drops: (ctx) => (ctx && (ctx.silkTouch || ctx.tool === 'shears') ? [st('dead_bush')] : [st('stick', rint(ctx && ctx.rng, 0, 2))]) });
definePlant('seagrass', { tint: 'grass', replaceable: true, waterlogged: true, flammable: 0, drops: (ctx) => (ctx && ctx.tool === 'shears' ? [st('seagrass')] : []) });
definePlant('tall_seagrass', { tint: 'grass', replaceable: true, waterlogged: true, flammable: 0, drops: (ctx) => (ctx && ctx.tool === 'shears' ? [st('seagrass', 2)] : []) });
definePlant('kelp', { waterlogged: true, flammable: 0, ticksRandomly: true, replaceable: true });
definePlant('kelp_plant', { tex: 'kelp_plant', waterlogged: true, flammable: 0, drops: 'kelp', itemName: 'kelp' });
definePlant('sugar_cane', { tint: 'grass', ticksRandomly: true, flammable: 0 });
definePlant('bamboo', { ticksRandomly: true, collision: 'custom', boxes: [[0.375, 0, 0.375, 0.625, 1, 0.625]], solid: true, sound: 'wood', burnTime: 50 });
definePlant('bamboo_sapling', { tex: 'bamboo_stage0', ticksRandomly: true, drops: 'bamboo', itemName: 'bamboo' });
definePlant('nether_sprouts', { flammable: 0, sound: 'nether_wart' });
definePlant('crimson_roots', { flammable: 0, sound: 'nether_wart' });
definePlant('warped_roots', { flammable: 0, sound: 'nether_wart' });
definePlant('crimson_fungus', { flammable: 0, sound: 'nether_wart', ticksRandomly: true });
definePlant('warped_fungus', { flammable: 0, sound: 'nether_wart', ticksRandomly: true });
definePlant('weeping_vines', { flammable: 0, climbable: true, ticksRandomly: true, sound: 'nether_wart' });
definePlant('weeping_vines_plant', { flammable: 0, climbable: true, drops: 'weeping_vines', itemName: 'weeping_vines', sound: 'nether_wart' });
definePlant('twisting_vines', { flammable: 0, climbable: true, ticksRandomly: true, sound: 'nether_wart' });
definePlant('twisting_vines_plant', { flammable: 0, climbable: true, drops: 'twisting_vines', itemName: 'twisting_vines', sound: 'nether_wart' });
definePlant('cave_vines', { ticksRandomly: true, climbable: true, litLight: 14, litBit: 8, drops: [{ item: 'glow_berries', count: 1, chance: 0.3 }] });
definePlant('cave_vines_plant', { ticksRandomly: true, climbable: true, litLight: 14, litBit: 8, drops: [{ item: 'glow_berries', count: 1, chance: 0.3 }] });
definePlant('hanging_roots', { drops: 'hanging_roots' });
definePlant('spore_blossom', { flammable: 0 });
definePlant('small_dripleaf', { tint: 'grass' });
definePlant('big_dripleaf', { collision: 'custom', boxes: [[0, 0.6875, 0, 1, 0.9375, 1]], solid: true });
definePlant('big_dripleaf_stem', { drops: 'big_dripleaf', itemName: 'big_dripleaf' });
definePlant('azalea', { sound: 'grass', flammable: 30, solid: true, collision: 'full', opaque: false });
definePlant('flowering_azalea', { sound: 'grass', flammable: 30, solid: true, collision: 'full', opaque: false });
definePlant('pitcher_plant', { flammable: 30 });
definePlant('torchflower', { flammable: 30 });
definePlant('brown_mushroom', { light: 1, ticksRandomly: true, flammable: 0 });
definePlant('red_mushroom', { ticksRandomly: true, flammable: 0 });
definePlant('crimson_fungus_planted', { tex: 'crimson_fungus', flammable: 0, drops: 'crimson_fungus', itemName: 'crimson_fungus' });

const FLOWERS = [
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
  'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
];
for (const f of FLOWERS) definePlant(f, { flammable: 60 });
definePlant('wither_rose', { flammable: 60 });
definePlant('sunflower', { flammable: 60 });
definePlant('lilac', { flammable: 60 });
definePlant('rose_bush', { flammable: 60 });
definePlant('peony', { flammable: 60 });

defineBlock('vine', {
  model: 'vine', tex: 'vine', tint: 'foliage', solid: false, opaque: false, filter: 0,
  collision: 'none', climbable: true, hardness: 0.2, resistance: 0.2, sound: 'grass',
  flammable: 15, ticksRandomly: true, renderPass: 'cutout', group: 'decoration',
  drops: (ctx) => (ctx && (ctx.silkTouch || ctx.tool === 'shears') ? [st('vine')] : []),
});
defineBlock('glow_lichen', {
  model: 'vine', tex: 'glow_lichen', solid: false, opaque: false, filter: 0, collision: 'none',
  hardness: 0.2, resistance: 0.2, sound: 'grass', light: 7, renderPass: 'cutout',
  group: 'decoration', drops: (ctx) => (ctx && (ctx.silkTouch || ctx.tool === 'shears') ? [st('glow_lichen')] : []),
});
defineBlock('lily_pad', {
  model: 'carpet', tex: 'lily_pad', tint: 'foliage', solid: false, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 0.09375, 0.9375]],
  hardness: 0, resistance: 0, sound: 'grass', renderPass: 'cutout', group: 'decoration',
});
defineBlock('cactus', {
  model: 'cactus', tex: { top: 'cactus_top', bottom: 'cactus_bottom', side: 'cactus_side' },
  hardness: 0.4, resistance: 0.4, sound: 'wool', opaque: false, filter: 0,
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 0.9375, 0.9375]],
  ticksRandomly: true, renderPass: 'cutout', group: 'decoration',
});
defineBlock('cobweb', {
  model: 'cross', tex: 'cobweb', solid: false, opaque: false, filter: 0, collision: 'none',
  hardness: 4, resistance: 4, tool: 'sword', requiresTool: true, renderPass: 'cutout',
  group: 'decoration', drops: (ctx) => [st(ctx && ctx.silkTouch ? 'cobweb' : 'string')],
});

// Huge mushrooms
defineBlock('brown_mushroom_block', { hardness: 0.2, resistance: 0.2, tool: 'axe', sound: 'wool', drops: silkOrItem('brown_mushroom_block', 'brown_mushroom', 0, 2) });
defineBlock('red_mushroom_block', { hardness: 0.2, resistance: 0.2, tool: 'axe', sound: 'wool', drops: silkOrItem('red_mushroom_block', 'red_mushroom', 0, 2) });
defineBlock('mushroom_stem', { hardness: 0.2, resistance: 0.2, tool: 'axe', sound: 'wool', drops: silkOnly('mushroom_stem') });

// Sculk family
defineBlock('sculk', { hardness: 0.2, resistance: 0.2, tool: 'hoe', sound: 'wool', xp: [1, 1], drops: silkOnly('sculk'), group: 'decoration' });
defineBlock('sculk_vein', {
  model: 'vine', tex: 'sculk_vein', solid: false, opaque: false, filter: 0, collision: 'none',
  hardness: 0.2, resistance: 0.2, tool: 'hoe', sound: 'wool', renderPass: 'cutout',
  group: 'decoration', drops: silkOnly('sculk_vein'),
});
defineBlock('sculk_catalyst', {
  tex: { top: 'sculk_catalyst_top', bottom: 'sculk_catalyst_bottom', side: 'sculk_catalyst_side' },
  hardness: 3, resistance: 3, tool: 'hoe', sound: 'wool', light: 6, xp: [5, 5],
  drops: silkOnly('sculk_catalyst'), group: 'decoration',
});
defineBlock('sculk_shrieker', {
  model: 'slab', tex: { top: 'sculk_shrieker_top', bottom: 'sculk_shrieker_bottom', side: 'sculk_shrieker_side' },
  hardness: 3, resistance: 3, tool: 'hoe', sound: 'wool', opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.5, 1]], renderPass: 'opaque',
  drops: silkOnly('sculk_shrieker'), group: 'redstone',
});
defineBlock('sculk_sensor', {
  model: 'slab', tex: { top: 'sculk_sensor_top', bottom: 'sculk_sensor_bottom', side: 'sculk_sensor_side' },
  hardness: 1.5, resistance: 1.5, tool: 'hoe', sound: 'wool', opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.5, 1]], renderPass: 'opaque',
  light: 0, litLight: 1, litBit: 8, group: 'redstone', drops: silkOnly('sculk_sensor'),
});
defineBlock('calibrated_sculk_sensor', {
  model: 'slab', tex: { top: 'calibrated_sculk_sensor_top', bottom: 'sculk_sensor_bottom', side: 'calibrated_sculk_sensor_side' },
  hardness: 1.5, resistance: 1.5, tool: 'hoe', sound: 'wool', opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.5, 1]], renderPass: 'opaque',
  light: 0, litLight: 1, litBit: 8, group: 'redstone', drops: silkOnly('calibrated_sculk_sensor'),
});

// Coral: 5 species x (block, coral, fan, wall fan) x (alive, dead)
const CORALS = ['tube', 'brain', 'bubble', 'fire', 'horn'];
for (const c of CORALS) {
  for (const dead of [false, true]) {
    const pre = dead ? 'dead_' : '';
    defineBlock(pre + c + '_coral_block', {
      hardness: 1.5, resistance: 6, tool: 'pickaxe', requiresTool: true, sound: 'stone',
      ticksRandomly: !dead, group: 'decoration',
      drops: dead ? (pre + c + '_coral_block') : silkOnly(c + '_coral_block'),
    });
    defineBlock(pre + c + '_coral', {
      model: 'cross', tex: pre + c + '_coral', solid: false, opaque: false, filter: 0,
      collision: 'none', hardness: 0, resistance: 0, sound: 'stone', renderPass: 'cutout',
      waterlogged: true, group: 'decoration',
      drops: dead ? (pre + c + '_coral') : silkOnly(c + '_coral'),
    });
    defineBlock(pre + c + '_coral_fan', {
      model: 'cross', tex: pre + c + '_coral_fan', solid: false, opaque: false, filter: 0,
      collision: 'none', hardness: 0, resistance: 0, sound: 'stone', renderPass: 'cutout',
      waterlogged: true, group: 'decoration',
      drops: dead ? (pre + c + '_coral_fan') : silkOnly(c + '_coral_fan'),
    });
    defineBlock(pre + c + '_coral_wall_fan', {
      model: 'cross', tex: pre + c + '_coral_fan', solid: false, opaque: false, filter: 0,
      collision: 'none', hardness: 0, resistance: 0, sound: 'stone', renderPass: 'cutout',
      waterlogged: true, group: 'decoration', itemName: pre + c + '_coral_fan',
      drops: dead ? (pre + c + '_coral_fan') : silkOnly(c + '_coral_fan'),
    });
  }
}

// ===========================================================================
// 9. Crops and food blocks
// ===========================================================================
/** Growth-staged crop. `meta` is the growth stage; texture gets `_stageN`. */
function defineCrop(name, opts = {}) {
  return defineBlock(name, {
    model: 'crop', tex: name, solid: false, opaque: false, filter: 0, collision: 'none',
    hardness: 0, resistance: 0, sound: 'grass', renderPass: 'cutout', ticksRandomly: true,
    group: 'decoration', ...opts,
  });
}
defineCrop('wheat', { drops: cropDrops('wheat_seeds', 'wheat', 1, 1, 7) });
defineCrop('carrots', { drops: cropDrops('carrot', 'carrot', 1, 4, 7), itemName: 'carrot' });
defineCrop('potatoes', {
  itemName: 'potato',
  drops: (ctx) => {
    const meta = ctx ? ctx.meta | 0 : 0;
    if ((meta & 7) < 7) return [st('potato')];
    const out = [st('potato', rint(ctx && ctx.rng, 1, 4) + ((ctx && ctx.fortune | 0) ? Math.floor(rnd(ctx.rng) * ((ctx.fortune | 0) + 1)) : 0))];
    if (rnd(ctx && ctx.rng) < 0.02) out.push(st('poisonous_potato'));
    return out;
  },
});
defineCrop('beetroots', { drops: cropDrops('beetroot_seeds', 'beetroot', 1, 1, 3), itemName: 'beetroot_seeds' });
defineCrop('torchflower_crop', { drops: 'torchflower_seeds', itemName: 'torchflower_seeds' });
defineCrop('pitcher_crop', { drops: 'pitcher_pod', itemName: 'pitcher_pod' });
defineCrop('nether_wart', { sound: 'nether_wart', drops: cropDrops('nether_wart', 'nether_wart', 2, 4, 3), itemName: 'nether_wart' });
defineCrop('melon_stem', { drops: 'melon_seeds', itemName: 'melon_seeds' });
defineCrop('pumpkin_stem', { drops: 'pumpkin_seeds', itemName: 'pumpkin_seeds' });
defineCrop('attached_melon_stem', { tex: 'attached_melon_stem', model: 'cross', drops: 'melon_seeds', itemName: 'melon_seeds' });
defineCrop('attached_pumpkin_stem', { tex: 'attached_pumpkin_stem', model: 'cross', drops: 'pumpkin_seeds', itemName: 'pumpkin_seeds' });

defineBlock('melon', {
  tex: { top: 'melon_top', bottom: 'melon_top', side: 'melon_side' },
  hardness: 1, resistance: 1, tool: 'axe', sound: 'wood', group: 'decoration',
  drops: silkOrItem('melon', 'melon_slice', 3, 7, 9),
});
defineBlock('pumpkin', {
  tex: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side' },
  hardness: 1, resistance: 1, tool: 'axe', sound: 'wood', group: 'decoration',
});
defineBlock('carved_pumpkin', {
  tex: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'carved_pumpkin' },
  hardness: 1, resistance: 1, tool: 'axe', sound: 'wood', group: 'decoration',
});
defineBlock('jack_o_lantern', {
  tex: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'jack_o_lantern' },
  hardness: 1, resistance: 1, tool: 'axe', sound: 'wood', light: 15, group: 'decoration',
});
defineBlock('hay_block', { model: 'column', tex: { top: 'hay_block_top', side: 'hay_block_side' }, hardness: 0.5, resistance: 0.5, tool: 'hoe', sound: 'grass', flammable: 60, burnTime: 0 });
defineBlock('dried_kelp_block', { hardness: 0.5, resistance: 2.5, tool: 'hoe', sound: 'grass', burnTime: 4000 });
defineBlock('sponge', { hardness: 0.6, resistance: 0.6, tool: 'hoe', sound: 'grass', burnTime: 300 });
defineBlock('wet_sponge', { hardness: 0.6, resistance: 0.6, tool: 'hoe', sound: 'grass' });
defineBlock('slime_block', {
  hardness: 0, resistance: 0, sound: 'slime', slipperiness: 0.8, opaque: false,
  filter: 0, renderPass: 'translucent', group: 'decoration',
});
defineBlock('honey_block', {
  hardness: 0, resistance: 0, sound: 'slime', slipperiness: 0.4, opaque: false,
  filter: 0, renderPass: 'translucent', group: 'decoration',
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 1, 0.9375]],
});
defineBlock('cake', {
  model: 'cube', tex: { top: 'cake_top', bottom: 'cake_bottom', side: 'cake_side' },
  hardness: 0.5, resistance: 0.5, sound: 'wool', opaque: false, filter: 0,
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 0.5, 0.9375]],
  renderPass: 'cutout', drops: null, group: 'food',
});
defineBlock('sweet_berry_bush', {
  model: 'cross', tex: 'sweet_berry_bush_stage3', solid: false, opaque: false, filter: 0,
  collision: 'none', hardness: 0, resistance: 0, sound: 'grass', ticksRandomly: true,
  renderPass: 'cutout', group: 'decoration', itemName: 'sweet_berries',
  drops: (ctx) => [st('sweet_berries', rint(ctx && ctx.rng, 1, 3))],
});
defineBlock('cocoa', {
  model: 'crop', tex: 'cocoa', solid: false, opaque: false, filter: 0, collision: 'none',
  hardness: 0.2, resistance: 3, tool: 'axe', sound: 'wood', ticksRandomly: true,
  renderPass: 'cutout', group: 'decoration', itemName: 'cocoa_beans',
  drops: (ctx) => [st('cocoa_beans', ((ctx ? ctx.meta | 0 : 0) & 7) >= 2 ? 3 : 1)],
});
defineBlock('chorus_plant', {
  hardness: 0.4, resistance: 0.4, tool: 'axe', sound: 'wood', opaque: false, filter: 0,
  renderPass: 'cutout', group: 'decoration',
  drops: [{ item: 'chorus_fruit', count: 1, chance: 0.5 }],
});
defineBlock('chorus_flower', {
  hardness: 0.4, resistance: 0.4, tool: 'axe', sound: 'wood', opaque: false, filter: 0,
  renderPass: 'cutout', ticksRandomly: true, group: 'decoration',
});
defineBlock('sea_pickle', {
  model: 'cross', tex: 'sea_pickle', solid: false, opaque: false, filter: 0, collision: 'none',
  hardness: 0, resistance: 0, sound: 'slime', light: 6, waterlogged: true,
  renderPass: 'cutout', group: 'decoration',
});
defineBlock('turtle_egg', {
  model: 'pot', tex: 'turtle_egg', solid: false, opaque: false, filter: 0, collision: 'none',
  hardness: 0.5, resistance: 0.5, sound: 'stone', ticksRandomly: true,
  renderPass: 'cutout', group: 'decoration', drops: silkOnly('turtle_egg'),
});
defineBlock('sniffer_egg', {
  tex: 'sniffer_egg_not_cracked_top', hardness: 0.5, resistance: 0.5, sound: 'stone',
  opaque: false, filter: 0, ticksRandomly: true, renderPass: 'cutout', group: 'decoration',
});
defineBlock('dragon_egg', {
  hardness: 3, resistance: 9, light: 1, opaque: false, filter: 0, gravity: true,
  renderPass: 'cutout', group: 'decoration',
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 1, 0.9375]],
});

// ===========================================================================
// 10. Utility / functional blocks
// ===========================================================================
defineBlock('crafting_table', {
  tex: { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side', front: 'crafting_table_front' },
  hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood', flammable: 5, burnTime: 300, group: 'building',
});
const machine = (name, extra = {}) => defineBlock(name, {
  tex: {
    top: name + '_top', bottom: name + '_top', side: name + '_side', front: name + '_front',
  },
  hardness: 3.5, resistance: 3.5, tool: 'pickaxe', requiresTool: true, entityType: 'furnace',
  light: 0, litLight: 13, litBit: 4, group: 'decoration', ...extra,
});
machine('furnace');
machine('blast_furnace');
machine('smoker', { tex: { top: 'smoker_top', bottom: 'smoker_bottom', side: 'smoker_side', front: 'smoker_front' } });
defineBlock('dispenser', {
  tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'dispenser_front' },
  hardness: 3.5, resistance: 3.5, tool: 'pickaxe', requiresTool: true, entityType: 'hopper', group: 'redstone',
});
defineBlock('dropper', {
  tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'dropper_front' },
  hardness: 3.5, resistance: 3.5, tool: 'pickaxe', requiresTool: true, entityType: 'hopper', group: 'redstone',
});
defineBlock('observer', {
  tex: { top: 'observer_top', bottom: 'observer_top', side: 'observer_side', front: 'observer_front', back: 'observer_back' },
  hardness: 3.5, resistance: 3.5, tool: 'pickaxe', requiresTool: true, group: 'redstone',
});
defineBlock('chest', {
  model: 'chest', tex: 'oak_planks', hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood',
  entityType: 'chest', opaque: false, filter: 0, flammable: 5, burnTime: 300,
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]],
  renderPass: 'cutout', group: 'decoration',
});
defineBlock('trapped_chest', {
  model: 'chest', tex: 'oak_planks', hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood',
  entityType: 'chest', opaque: false, filter: 0, flammable: 5, burnTime: 300,
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]],
  renderPass: 'cutout', group: 'redstone',
});
defineBlock('ender_chest', {
  model: 'chest', tex: 'obsidian', hardness: 22.5, resistance: 600, tool: 'pickaxe',
  requiresTool: true, entityType: 'chest', opaque: false, filter: 0, light: 7,
  collision: 'custom', boxes: [[0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]],
  renderPass: 'cutout', group: 'decoration', drops: (ctx) => (ctx && ctx.silkTouch ? [st('ender_chest')] : [st('obsidian', 8)]),
});
defineBlock('barrel', {
  tex: { top: 'barrel_top', bottom: 'barrel_bottom', side: 'barrel_side' },
  hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood', entityType: 'chest',
  flammable: 5, burnTime: 300, group: 'decoration',
});
defineBlock('hopper', {
  model: 'hopper', tex: { top: 'hopper_top', bottom: 'hopper_outside', side: 'hopper_outside', inner: 'hopper_inside' },
  hardness: 3, resistance: 4.8, tool: 'pickaxe', requiresTool: true, sound: 'metal',
  entityType: 'hopper', opaque: false, filter: 0, collision: 'custom',
  boxes: [[0, 0, 0, 1, 0.625, 1]], renderPass: 'cutout', group: 'redstone',
});
defineBlock('piston', {
  model: 'piston', tex: { top: 'piston_top', bottom: 'piston_bottom', side: 'piston_side', front: 'piston_top' },
  hardness: 1.5, resistance: 1.5, tool: 'pickaxe', opaque: false, filter: 0, group: 'redstone',
});
defineBlock('sticky_piston', {
  model: 'piston', tex: { top: 'piston_top_sticky', bottom: 'piston_bottom', side: 'piston_side', front: 'piston_top_sticky' },
  hardness: 1.5, resistance: 1.5, tool: 'pickaxe', opaque: false, filter: 0, group: 'redstone',
});
defineBlock('piston_head', {
  model: 'piston_head', tex: 'piston_top', hardness: 1.5, resistance: 1.5, tool: 'pickaxe',
  opaque: false, filter: 0, drops: null, group: 'redstone',
});
defineBlock('note_block', {
  hardness: 0.8, resistance: 0.8, tool: 'axe', sound: 'wood', entityType: 'note_block',
  flammable: 5, burnTime: 300, group: 'redstone',
});
defineBlock('jukebox', {
  tex: { top: 'jukebox_top', bottom: 'jukebox_side', side: 'jukebox_side' },
  hardness: 2, resistance: 6, tool: 'axe', sound: 'wood', entityType: 'jukebox',
  flammable: 5, burnTime: 300, group: 'decoration',
});
defineBlock('bookshelf', {
  tex: { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' },
  hardness: 1.5, resistance: 1.5, tool: 'axe', sound: 'wood', flammable: 30, burnTime: 300,
  drops: (ctx) => (ctx && ctx.silkTouch ? [st('bookshelf')] : [st('book', 3)]), group: 'building',
});
defineBlock('chiseled_bookshelf', {
  tex: { top: 'chiseled_bookshelf_top', bottom: 'chiseled_bookshelf_top', side: 'chiseled_bookshelf_side', front: 'chiseled_bookshelf_empty' },
  hardness: 1.5, resistance: 1.5, tool: 'axe', sound: 'wood', flammable: 30, burnTime: 300,
  entityType: 'lectern', group: 'decoration',
});
defineBlock('lectern', {
  tex: { top: 'lectern_top', bottom: 'oak_planks', side: 'lectern_sides', front: 'lectern_front' },
  hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood', entityType: 'lectern',
  opaque: false, filter: 0, flammable: 5, burnTime: 300, group: 'redstone',
});
defineBlock('enchanting_table', {
  tex: { top: 'enchanting_table_top', bottom: 'enchanting_table_bottom', side: 'enchanting_table_side' },
  hardness: 5, resistance: 1200, tool: 'pickaxe', requiresTool: true, light: 7,
  opaque: false, filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.75, 1]],
  renderPass: 'opaque', group: 'decoration',
});
for (const [n, h] of [['anvil', 5], ['chipped_anvil', 5], ['damaged_anvil', 5]]) {
  defineBlock(n, {
    model: 'anvil', tex: { top: 'anvil_top', bottom: 'anvil_base', side: 'anvil_base' },
    hardness: h, resistance: 1200, tool: 'pickaxe', tier: 1, requiresTool: true,
    sound: 'anvil', gravity: true, opaque: false, filter: 0, renderPass: 'opaque',
    collision: 'custom', boxes: [[0.125, 0, 0.125, 0.875, 1, 0.875]], group: 'decoration',
  });
}
defineBlock('brewing_stand', {
  model: 'pot', tex: 'brewing_stand', hardness: 0.5, resistance: 0.5, tool: 'pickaxe',
  requiresTool: true, entityType: 'brewing_stand', light: 1, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0.4375, 0, 0.4375, 0.5625, 0.875, 0.5625]],
  renderPass: 'cutout', group: 'brewing',
});
defineBlock('cauldron', {
  model: 'cauldron', tex: { top: 'cauldron_top', bottom: 'cauldron_bottom', side: 'cauldron_side', inner: 'cauldron_inner' },
  hardness: 2, resistance: 2, tool: 'pickaxe', requiresTool: true, sound: 'metal',
  opaque: false, filter: 0, collision: 'full', renderPass: 'cutout', group: 'brewing',
});
defineBlock('water_cauldron', {
  model: 'cauldron', tex: { top: 'cauldron_top', bottom: 'cauldron_bottom', side: 'cauldron_side', inner: 'water_still' },
  hardness: 2, resistance: 2, tool: 'pickaxe', requiresTool: true, sound: 'metal',
  opaque: false, filter: 0, renderPass: 'cutout', group: 'brewing', drops: 'cauldron', itemName: 'cauldron',
});
defineBlock('lava_cauldron', {
  model: 'cauldron', tex: { top: 'cauldron_top', bottom: 'cauldron_bottom', side: 'cauldron_side', inner: 'lava_still' },
  hardness: 2, resistance: 2, tool: 'pickaxe', requiresTool: true, sound: 'metal', light: 15,
  opaque: false, filter: 0, renderPass: 'cutout', group: 'brewing', drops: 'cauldron', itemName: 'cauldron',
});
defineBlock('powder_snow_cauldron', {
  model: 'cauldron', tex: { top: 'cauldron_top', bottom: 'cauldron_bottom', side: 'cauldron_side', inner: 'powder_snow' },
  hardness: 2, resistance: 2, tool: 'pickaxe', requiresTool: true, sound: 'metal',
  opaque: false, filter: 0, renderPass: 'cutout', group: 'brewing', drops: 'cauldron', itemName: 'cauldron',
});
defineBlock('beacon', {
  hardness: 3, resistance: 3, light: 15, sound: 'glass', entityType: 'beacon',
  opaque: false, filter: 0, renderPass: 'translucent', group: 'decoration',
});
defineBlock('conduit', {
  hardness: 3, resistance: 3, light: 15, opaque: false, filter: 0, renderPass: 'cutout',
  collision: 'custom', boxes: [[0.3125, 0.3125, 0.3125, 0.6875, 0.6875, 0.6875]], group: 'decoration',
});
defineBlock('respawn_anchor', {
  tex: { top: 'respawn_anchor_top_off', bottom: 'respawn_anchor_bottom', side: 'respawn_anchor_side0' },
  hardness: 50, resistance: 1200, tool: 'pickaxe', tier: 3, requiresTool: true,
  light: 0, litLight: 15, litBit: 8, group: 'decoration',
});
defineBlock('lodestone', {
  tex: { top: 'lodestone_top', bottom: 'lodestone_top', side: 'lodestone_side' },
  hardness: 3.5, resistance: 3.5, tool: 'pickaxe', tier: 1, requiresTool: true, sound: 'metal', group: 'decoration',
});
defineBlock('loom', {
  tex: { top: 'loom_top', bottom: 'oak_planks', side: 'loom_side', front: 'loom_front' },
  hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood', flammable: 5, burnTime: 300, group: 'decoration',
});
defineBlock('smithing_table', {
  tex: { top: 'smithing_table_top', bottom: 'smithing_table_bottom', side: 'smithing_table_side', front: 'smithing_table_front' },
  hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood', flammable: 5, burnTime: 300, group: 'decoration',
});
defineBlock('fletching_table', {
  tex: { top: 'fletching_table_top', bottom: 'birch_planks', side: 'fletching_table_side', front: 'fletching_table_front' },
  hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood', flammable: 5, burnTime: 300, group: 'decoration',
});
defineBlock('cartography_table', {
  tex: { top: 'cartography_table_top', bottom: 'dark_oak_planks', side: 'cartography_table_side1', front: 'cartography_table_side3' },
  hardness: 2.5, resistance: 2.5, tool: 'axe', sound: 'wood', flammable: 5, burnTime: 300, group: 'decoration',
});
defineBlock('stonecutter', {
  tex: { top: 'stonecutter_top', bottom: 'stonecutter_bottom', side: 'stonecutter_side' },
  hardness: 3.5, resistance: 3.5, tool: 'pickaxe', requiresTool: true, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.5625, 1]], renderPass: 'opaque', group: 'decoration',
});
defineBlock('grindstone', {
  tex: { top: 'grindstone_round', bottom: 'grindstone_round', side: 'grindstone_side' },
  hardness: 2, resistance: 6, tool: 'pickaxe', requiresTool: true, opaque: false, filter: 0,
  renderPass: 'cutout', group: 'decoration',
});
defineBlock('composter', {
  model: 'cauldron', tex: { top: 'composter_top', bottom: 'composter_bottom', side: 'composter_side', inner: 'composter_compost' },
  hardness: 0.6, resistance: 0.6, tool: 'axe', sound: 'wood', opaque: false, filter: 0,
  flammable: 5, burnTime: 300, renderPass: 'cutout', group: 'decoration',
});
defineBlock('bell', {
  model: 'lantern', tex: { top: 'bell_top', bottom: 'bell_bottom', side: 'bell_side' },
  hardness: 5, resistance: 5, tool: 'pickaxe', requiresTool: true, sound: 'metal',
  opaque: false, filter: 0, renderPass: 'cutout', group: 'decoration',
});
defineBlock('campfire', {
  model: 'slab', tex: { top: 'campfire_fire', bottom: 'campfire_log', side: 'campfire_log' },
  hardness: 2, resistance: 2, tool: 'axe', sound: 'wood', light: 15, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.4375, 1]], renderPass: 'cutout', group: 'decoration',
  drops: (ctx) => (ctx && ctx.silkTouch ? [st('campfire')] : [st('charcoal', 2)]),
});
defineBlock('soul_campfire', {
  model: 'slab', tex: { top: 'soul_campfire_fire', bottom: 'campfire_log', side: 'campfire_log' },
  hardness: 2, resistance: 2, tool: 'axe', sound: 'wood', light: 10, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.4375, 1]], renderPass: 'cutout', group: 'decoration',
  drops: (ctx) => (ctx && ctx.silkTouch ? [st('soul_campfire')] : [st('soul_soil')]),
});
defineBlock('scaffolding', {
  tex: { top: 'scaffolding_top', bottom: 'scaffolding_bottom', side: 'scaffolding_side' },
  hardness: 0, resistance: 0, sound: 'wood', climbable: true, opaque: false, filter: 0,
  flammable: 60, burnTime: 400, renderPass: 'cutout', group: 'building',
  collision: 'custom', boxes: [[0, 0.875, 0, 1, 1, 1]],
});
defineBlock('ladder', {
  model: 'ladder', tex: 'ladder', hardness: 0.4, resistance: 0.4, tool: 'axe', sound: 'ladder',
  climbable: true, solid: false, opaque: false, filter: 0, collision: 'none',
  flammable: 5, burnTime: 300, renderPass: 'cutout', group: 'decoration',
});
defineBlock('torch', {
  model: 'torch', tex: 'torch', hardness: 0, resistance: 0, light: 14, sound: 'wood',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
});
defineBlock('wall_torch', {
  model: 'torch', tex: 'torch', hardness: 0, resistance: 0, light: 14, sound: 'wood',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout',
  group: 'decoration', drops: 'torch', itemName: 'torch',
});
defineBlock('soul_torch', {
  model: 'torch', tex: 'soul_torch', hardness: 0, resistance: 0, light: 10, sound: 'wood',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
});
defineBlock('soul_wall_torch', {
  model: 'torch', tex: 'soul_torch', hardness: 0, resistance: 0, light: 10, sound: 'wood',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout',
  group: 'decoration', drops: 'soul_torch', itemName: 'soul_torch',
});
defineBlock('redstone_torch', {
  model: 'torch', tex: 'redstone_torch', hardness: 0, resistance: 0, light: 7, sound: 'wood',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'redstone',
});
defineBlock('redstone_wall_torch', {
  model: 'torch', tex: 'redstone_torch', hardness: 0, resistance: 0, light: 7, sound: 'wood',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout',
  group: 'redstone', drops: 'redstone_torch', itemName: 'redstone_torch',
});
defineBlock('lantern', {
  model: 'lantern', tex: 'lantern', hardness: 3.5, resistance: 3.5, tool: 'pickaxe',
  requiresTool: true, sound: 'metal', light: 15, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0.3125, 0, 0.3125, 0.6875, 0.5625, 0.6875]],
  renderPass: 'cutout', group: 'decoration',
});
defineBlock('soul_lantern', {
  model: 'lantern', tex: 'soul_lantern', hardness: 3.5, resistance: 3.5, tool: 'pickaxe',
  requiresTool: true, sound: 'metal', light: 10, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0.3125, 0, 0.3125, 0.6875, 0.5625, 0.6875]],
  renderPass: 'cutout', group: 'decoration',
});
defineBlock('end_rod', {
  model: 'end_rod', tex: 'end_rod', hardness: 0, resistance: 0, light: 14, sound: 'wood',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
});
defineBlock('lightning_rod', {
  model: 'end_rod', tex: 'lightning_rod', hardness: 3, resistance: 6, tool: 'pickaxe',
  requiresTool: true, sound: 'metal', opaque: false, filter: 0, collision: 'thin',
  renderPass: 'cutout', group: 'redstone',
});
defineBlock('tnt', {
  tex: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' },
  hardness: 0, resistance: 0, sound: 'grass', flammable: 15, group: 'redstone',
});
defineBlock('spawner', {
  tex: 'spawner', hardness: 5, resistance: 5, tool: 'pickaxe', requiresTool: true,
  sound: 'metal', entityType: 'spawner', opaque: false, filter: 0, renderPass: 'cutout',
  xp: [15, 43], drops: null, group: 'misc',
});
defineBlock('trial_spawner', {
  tex: { top: 'trial_spawner_top_inactive', bottom: 'trial_spawner_bottom', side: 'trial_spawner_side_inactive' },
  hardness: 50, resistance: 50, tool: 'pickaxe', requiresTool: true, sound: 'metal',
  entityType: 'spawner', drops: null, group: 'misc',
});
defineBlock('end_portal_frame', {
  tex: { top: 'end_portal_frame_top', bottom: 'end_stone', side: 'end_portal_frame_side' },
  hardness: -1, resistance: 3600000, light: 1, opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.8125, 1]], renderPass: 'opaque',
  drops: null, group: 'misc',
});
defineBlock('end_portal', {
  model: 'carpet', tex: 'end_portal', hardness: -1, resistance: 3600000, light: 15,
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'opaque',
  drops: null, group: 'misc',
});
defineBlock('end_gateway', {
  tex: 'end_portal', hardness: -1, resistance: 3600000, light: 15, solid: false,
  opaque: false, filter: 0, collision: 'none', renderPass: 'opaque', drops: null, group: 'misc',
});
defineBlock('nether_portal', {
  model: 'pane', tex: 'nether_portal', hardness: -1, resistance: 0, light: 11,
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'translucent',
  drops: null, group: 'misc',
});
defineBlock('beehive', {
  tex: { top: 'beehive_top', bottom: 'beehive_top', side: 'beehive_side', front: 'beehive_front' },
  hardness: 0.6, resistance: 0.6, tool: 'axe', sound: 'wood', flammable: 5, burnTime: 300,
  entityType: 'hopper', group: 'decoration',
});
defineBlock('bee_nest', {
  tex: { top: 'bee_nest_top', bottom: 'bee_nest_bottom', side: 'bee_nest_side', front: 'bee_nest_front' },
  hardness: 0.3, resistance: 0.3, tool: 'axe', sound: 'wood', flammable: 5, burnTime: 300,
  entityType: 'hopper', group: 'decoration',
});
defineBlock('honeycomb_block', { hardness: 0.6, resistance: 0.6, sound: 'wool', group: 'decoration' });
defineBlock('target', {
  tex: { top: 'target_top', bottom: 'target_top', side: 'target_side' },
  hardness: 0.5, resistance: 0.5, tool: 'hoe', sound: 'grass', group: 'redstone',
});
defineBlock('flower_pot', {
  model: 'pot', tex: 'flower_pot', hardness: 0, resistance: 0, solid: false, opaque: false,
  filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
});
defineBlock('decorated_pot', {
  model: 'pot', tex: 'decorated_pot_side', hardness: 0, resistance: 0, opaque: false,
  filter: 0, renderPass: 'cutout', group: 'decoration',
});

// Mob heads
for (const head of ['skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'player_head', 'creeper_head', 'dragon_head', 'piglin_head']) {
  defineBlock(head, {
    model: 'skull', tex: head, hardness: 1, resistance: 1, solid: false, opaque: false,
    filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
  });
  const wall = head.replace('_skull', '_wall_skull').replace('_head', '_wall_head');
  defineBlock(wall, {
    model: 'skull', tex: head, hardness: 1, resistance: 1, solid: false, opaque: false,
    filter: 0, collision: 'none', renderPass: 'cutout', group: 'decoration',
    drops: head, itemName: head,
  });
}

// ===========================================================================
// 11. Redstone
// ===========================================================================
defineBlock('redstone_wire', {
  model: 'flat', tex: 'redstone_dust_line0', tint: 'redstone', hardness: 0, resistance: 0,
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout',
  group: 'redstone', drops: 'redstone', itemName: 'redstone',
});
defineBlock('repeater', {
  model: 'flat', tex: 'repeater', hardness: 0, resistance: 0, solid: false, opaque: false,
  filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.125, 1]], renderPass: 'cutout',
  group: 'redstone', litAll: true, litBit: 8,
});
defineBlock('comparator', {
  model: 'flat', tex: 'comparator', hardness: 0, resistance: 0, solid: false, opaque: false,
  filter: 0, collision: 'custom', boxes: [[0, 0, 0, 1, 0.125, 1]], renderPass: 'cutout',
  group: 'redstone', litAll: true, litBit: 8,
});
defineBlock('lever', {
  model: 'lever', tex: 'lever', hardness: 0.5, resistance: 0.5, solid: false, opaque: false,
  filter: 0, collision: 'none', renderPass: 'cutout', group: 'redstone', sound: 'wood',
});
defineBlock('tripwire_hook', {
  model: 'lever', tex: 'tripwire_hook', hardness: 0, resistance: 0, solid: false, opaque: false,
  filter: 0, collision: 'none', renderPass: 'cutout', group: 'redstone',
});
defineBlock('tripwire', {
  model: 'flat', tex: 'tripwire', hardness: 0, resistance: 0, solid: false, opaque: false,
  filter: 0, collision: 'none', renderPass: 'cutout', group: 'redstone',
  drops: 'string', itemName: 'string',
});
defineBlock('daylight_detector', {
  model: 'slab', tex: { top: 'daylight_detector_top', bottom: 'daylight_detector_side', side: 'daylight_detector_side' },
  hardness: 0.2, resistance: 0.2, tool: 'axe', sound: 'wood', opaque: false, filter: 0,
  collision: 'custom', boxes: [[0, 0, 0, 1, 0.375, 1]], renderPass: 'opaque', group: 'redstone',
});
defineBlock('redstone_lamp', {
  tex: 'redstone_lamp', hardness: 0.3, resistance: 0.3, sound: 'glass',
  light: 0, litLight: 15, litBit: 1, litAll: true, group: 'redstone',
});
defineBlock('stone_button', {
  model: 'button', tex: 'stone', hardness: 0.5, resistance: 0.5, tool: 'pickaxe',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'redstone',
});
defineBlock('polished_blackstone_button', {
  model: 'button', tex: 'polished_blackstone', hardness: 0.5, resistance: 0.5, tool: 'pickaxe',
  solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'redstone',
});
for (const [n, t] of [
  ['stone_pressure_plate', 'stone'],
  ['polished_blackstone_pressure_plate', 'polished_blackstone'],
  ['light_weighted_pressure_plate', 'gold_block'],
  ['heavy_weighted_pressure_plate', 'iron_block'],
]) {
  defineBlock(n, {
    model: 'flat', tex: t, hardness: 0.5, resistance: 0.5, tool: 'pickaxe',
    solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'redstone',
  });
}
for (const r of ['rail', 'powered_rail', 'detector_rail', 'activator_rail']) {
  defineBlock(r, {
    model: 'rail', tex: r, hardness: 0.7, resistance: 0.7, tool: 'pickaxe', sound: 'metal',
    solid: false, opaque: false, filter: 0, collision: 'none', renderPass: 'cutout', group: 'transport',
  });
}
defineBlock('iron_door', {
  model: 'door', tex: 'iron_door', hardness: 5, resistance: 5, tool: 'pickaxe', tier: 1,
  requiresTool: true, sound: 'metal', opaque: false, filter: 0, collision: 'custom',
  boxes: [[0, 0, 0, 1, 1, 0.1875]], renderPass: 'cutout', group: 'redstone',
});
defineBlock('iron_trapdoor', {
  model: 'trapdoor', tex: 'iron_trapdoor', hardness: 5, resistance: 5, tool: 'pickaxe', tier: 1,
  requiresTool: true, sound: 'metal', opaque: false, filter: 0, collision: 'custom',
  boxes: [[0, 0, 0, 1, 0.1875, 1]], renderPass: 'cutout', group: 'redstone',
});

// ===========================================================================
// 12. Freeze the name table
// ===========================================================================
/** Every registered block name, in id order. */
export const BLOCK_NAMES = Object.freeze(_names.slice());

// Sanity: id 0 must be air and id 1 must be stone (other modules assume it).
if (BLOCKS[0].name !== 'air' || BLOCKS[1].name !== 'stone') {
  console.error('[blocks] registry order broken: 0 =', BLOCKS[0].name, '1 =', BLOCKS[1].name);
}
