// ============================================================================
// particles.js - The particle system.
//
// Design
//  - One flat pool of `max` particles held in structure-of-arrays typed arrays,
//    plus a free-list stack. Spawning pops an index; dying pushes it back.
//    Nothing here allocates after construction (the only `new` in the hot path
//    would be a THREE object, and there are none).
//  - Rendering uses three InstancedBufferGeometry quads - one per blending
//    family (alpha-tested / alpha-blended / additive) - so the whole system is
//    three draw calls no matter how many particles are alive. The quads are
//    billboarded in the vertex shader by offsetting the *view space* position,
//    which is both cheaper and more robust than gl_PointSize sprites (no size
//    clamp, no popping when the centre leaves the frustum, free rotation).
//  - Colour management: the atlas texture is sRGB and the renderer outputs
//    sRGB, so the shader decodes the texel, works in linear light (which is
//    also where scene.fog lives) and encodes once at the end.
//  - Fog is replicated from `scene.fog` through our own uniforms rather than
//    three's fog chunks, so the module cannot break when three renames a
//    shader chunk, and so additive particles can fade to black instead of to
//    the fog colour.
// ============================================================================
import * as THREE from 'three';

import { Game } from '../core/game.js';
import { clamp, hsvToRgb } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { WORLD_HEIGHT, FACE_DIRS, FACE_NAMES } from '../core/constants.js';
import { Atlas, buildAtlas } from './atlas.js';
import {
  getBlock as blockDefOf, isSolid as blockIsSolid, getTexture, blockByName,
} from '../world/blocks.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const DEFAULT_MAX = 4096;
const PARTICLE_CULL_DIST = 128;   // blocks; past this a particle is a wasted quad
const G_CUTOUT = 0, G_BLEND = 1, G_ADD = 2;
const GROUP_COUNT = 3;

// flags bitfield
const F_COLLIDE = 1;
const F_LIT = 2;
const F_DIE_ON_GROUND = 4;
const F_WATER_ONLY = 8;
const F_ON_GROUND = 16;
const F_TRAIL = 32;

// behaviour ids
const BH_BASIC = 0, BH_SMOKE = 1, BH_FLAME = 2, BH_LAVA = 3, BH_BUBBLE = 4,
  BH_SPLASH = 5, BH_RAIN = 6, BH_CRIT = 7, BH_SPELL = 8, BH_ENCHANT = 9,
  BH_HEART = 10, BH_ANGRY = 11, BH_NOTE = 12, BH_PORTAL = 13, BH_EXPLODE = 14,
  BH_CLOUD = 15, BH_DUST = 16, BH_BLOCK = 17, BH_SWEEP = 18, BH_FIREWORK = 19,
  BH_DRIP = 20, BH_SOUL = 21, BH_CAMPFIRE = 22, BH_ENDROD = 23, BH_TOTEM = 24,
  BH_DAMAGE = 25, BH_SPORE = 26, BH_CHERRY = 27, BH_GLOW = 28, BH_ASH = 29,
  BH_FLASH = 30, BH_RISE = 31;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Colour helpers. Instance colours are uploaded in linear light.
// ---------------------------------------------------------------------------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const linR = (hex) => LIN[(hex >> 16) & 255];
const linG = (hex) => LIN[(hex >> 8) & 255];
const linB = (hex) => LIN[hex & 255];

// Gamma curve shared with the mesher so particles sit at the same brightness
// as the blocks around them.
const LIGHT_LUT = new Float32Array(16);
for (let i = 0; i < 16; i++) LIGHT_LUT[i] = 0.05 + 0.95 * Math.pow(i / 15, 1.4);

// ---------------------------------------------------------------------------
// Atlas UV helpers
// ---------------------------------------------------------------------------
const _rectCache = new Map();

/** Whole-tile UV rect [u, v, du, dv] for a texture name, with a half-texel inset. */
function uvRect(name) {
  let r = _rectCache.get(name);
  if (r) return r;
  let idx = 0;
  try { idx = Atlas.index(name) | 0; } catch { idx = 0; }
  const cols = (Atlas && Atlas.cols) || 64;
  const size = (Atlas && Atlas.size) || 1024;
  const s = 1 / cols;
  const inset = 0.5 / size;
  r = [
    (idx % cols) * s + inset,
    (((idx / cols) | 0)) * s + inset,
    s - inset * 2,
    s - inset * 2,
  ];
  _rectCache.set(name, r);
  return r;
}

/**
 * A 4x4-texel sub-region of a 16x16 tile, the classic look of block-break
 * particles. `sx`/`sy` are in texels (0..12).
 */
function subRect(name, sx, sy, out) {
  let idx = 0;
  try { idx = Atlas.index(name) | 0; } catch { idx = 0; }
  const cols = (Atlas && Atlas.cols) || 64;
  const tile = (Atlas && Atlas.tile) || 16;
  const s = 1 / cols;
  const texel = s / tile;
  const inset = texel * 0.25;
  out[0] = (idx % cols) * s + sx * texel + inset;
  out[1] = (((idx / cols) | 0)) * s + sy * texel + inset;
  out[2] = texel * 4 - inset * 2;
  out[3] = texel * 4 - inset * 2;
  return out;
}
const _sub = [0, 0, 0, 0];

// ---------------------------------------------------------------------------
// Type registry
// ---------------------------------------------------------------------------
/** name -> resolved type descriptor. */
const TYPES = new Map();
/** alias -> canonical type name. */
const ALIASES = new Map();

/**
 * Registers a particle type. Every field has a default so call sites only list
 * what actually differs.
 */
function defType(name, o) {
  TYPES.set(name, {
    name,
    behav: o.behav ?? BH_BASIC,
    group: o.group ?? G_BLEND,
    tex: o.tex ?? 'particle_generic_3',
    count: o.count ?? 1,
    sizeMin: o.size ? o.size[0] : 0.12,
    sizeMax: o.size ? o.size[1] : 0.18,
    grow: o.grow ?? 1,
    lifeMin: o.life ? o.life[0] : 0.8,
    lifeMax: o.life ? o.life[1] : 1.2,
    gravity: o.gravity ?? 0,
    drag: o.drag ?? 0.6,
    speed: o.speed ?? 0,
    vy: o.vy ?? 0,
    spread: o.spread ?? 0.1,
    color: o.color ?? 0xffffff,
    randomColor: o.randomColor === true,
    alpha: o.alpha ?? 1,
    spin: o.spin ?? 0,
    randomSpin: o.randomSpin === true,
    collide: o.collide === true,
    dieOnGround: o.dieOnGround === true,
    water: o.water === true,
    lit: o.lit === true,
    block: o.block === true,
    trail: o.trail === true,
    keep: o.keep === true,
    flat: o.flat === true,   // spread applies to X/Z only
  });
}
const aliasType = (from, to) => ALIASES.set(from, to);

/** Resolve a type name (following aliases) to its descriptor, or null. */
function typeOf(name) {
  if (typeof name !== 'string') return null;
  let t = TYPES.get(name);
  if (t) return t;
  const a = ALIASES.get(name);
  if (a) {
    t = TYPES.get(a);
    if (t) return t;
  }
  return null;
}

// --- the types ---------------------------------------------------------------
defType('smoke', {
  behav: BH_SMOKE, group: G_BLEND, tex: 'particle_smoke', lit: true,
  size: [0.09, 0.16], grow: 1.8, life: [0.9, 1.8], gravity: -0.35, drag: 1.5,
  speed: 0.14, vy: 0.4, spread: 0.1, alpha: 0.85,
});
defType('large_smoke', {
  behav: BH_SMOKE, group: G_BLEND, tex: 'particle_smoke', lit: true,
  size: [0.22, 0.36], grow: 1.6, life: [1.4, 2.6], gravity: -0.3, drag: 1.2,
  speed: 0.12, vy: 0.3, spread: 0.2, alpha: 0.8,
});
defType('campfire_smoke', {
  behav: BH_CAMPFIRE, group: G_BLEND, tex: 'particle_cloud', color: 0xb8b4ac, lit: true,
  size: [0.3, 0.5], grow: 2.1, life: [5.0, 9.0], gravity: -0.04, drag: 0.22,
  speed: 0.06, vy: 0.95, spread: 0.14, alpha: 0.55,
});
defType('flame', {
  behav: BH_FLAME, group: G_BLEND, tex: 'particle_flame',
  size: [0.13, 0.2], grow: 0.12, life: [0.6, 1.15], gravity: -0.25, drag: 2.6,
  speed: 0.16, vy: 0.1, spread: 0.12, alpha: 1,
});
defType('lava', {
  behav: BH_LAVA, group: G_BLEND, tex: 'particle_lava', collide: true,
  size: [0.16, 0.26], grow: 0.55, life: [0.9, 1.8], gravity: 14, drag: 0.1,
  speed: 0.7, vy: 2.7, spread: 0.2, alpha: 1,
});
defType('bubble', {
  behav: BH_BUBBLE, group: G_CUTOUT, tex: 'particle_bubble', water: true, lit: true,
  size: [0.05, 0.11], grow: 1, life: [0.7, 1.7], gravity: -1.7, drag: 1.5,
  speed: 0.25, spread: 0.25, alpha: 1,
});
defType('splash', {
  behav: BH_SPLASH, group: G_BLEND, tex: 'particle_splash', lit: true,
  collide: true, dieOnGround: true,
  size: [0.08, 0.15], grow: 0.8, life: [0.35, 0.8], gravity: 15, drag: 0.3,
  speed: 1.1, vy: 1.4, spread: 0.25, alpha: 0.9,
});
defType('rain', {
  behav: BH_RAIN, group: G_BLEND, tex: 'particle_rain', lit: true,
  collide: true, dieOnGround: true,
  size: [0.16, 0.26], grow: 1, life: [0.4, 1.0], gravity: 24, drag: 0.05,
  speed: 0.05, spread: 0.05, alpha: 0.8,
});
defType('crit', {
  behav: BH_CRIT, group: G_BLEND, tex: 'particle_critical_hit', keep: true,
  count: 6, size: [0.12, 0.2], grow: 0.25, life: [0.4, 0.85], gravity: 3.5,
  drag: 3.2, speed: 2.2, spread: 0.28, spin: 9, randomSpin: true, alpha: 1,
});
defType('enchanted_hit', {
  behav: BH_CRIT, group: G_BLEND, tex: 'particle_enchanted_hit', keep: true,
  count: 6, size: [0.12, 0.2], grow: 0.25, life: [0.4, 0.85], gravity: 3.5,
  drag: 3.2, speed: 2.2, spread: 0.28, spin: 9, randomSpin: true, alpha: 1,
});
defType('magic', {
  behav: BH_SPELL, group: G_BLEND, tex: 'particle_spell',
  count: 4, size: [0.11, 0.2], grow: 0.45, life: [0.8, 1.5], gravity: -0.2,
  drag: 1.0, speed: 0.25, spread: 0.4, alpha: 0.85,
});
defType('enchant', {
  behav: BH_ENCHANT, group: G_BLEND, tex: 'particle_glint', color: 0xcdb9ff,
  count: 6, size: [0.1, 0.2], grow: 0.35, life: [0.8, 1.6], spread: 1.7,
  spin: 3, randomSpin: true, alpha: 1, drag: 0,
});
defType('heart', {
  behav: BH_HEART, group: G_BLEND, tex: 'particle_heart',
  size: [0.26, 0.32], grow: 1, life: [1.0, 1.5], gravity: -0.12, drag: 1.3,
  speed: 0.14, vy: 0.32, spread: 0.35, alpha: 1,
});
defType('angry', {
  behav: BH_ANGRY, group: G_BLEND, tex: 'particle_angry',
  size: [0.26, 0.34], grow: 1, life: [0.9, 1.3], gravity: 2.6, drag: 0.9,
  speed: 0.12, vy: 0.95, spread: 0.18, alpha: 1,
});
defType('note', {
  behav: BH_NOTE, group: G_BLEND, tex: 'particle_note', randomColor: true,
  size: [0.28, 0.36], grow: 1, life: [0.9, 1.3], gravity: 1.5, drag: 0.5,
  speed: 0.1, vy: 1.0, spread: 0.12, alpha: 1,
});
defType('portal', {
  behav: BH_PORTAL, group: G_BLEND, tex: 'particle_portal', color: 0xb46fe8,
  count: 4, size: [0.1, 0.2], grow: 0.45, life: [1.0, 2.2], spread: 1.3,
  drag: 0, alpha: 1,
});
defType('explosion', {
  behav: BH_EXPLODE, group: G_BLEND, tex: 'particle_explosion', lit: true, keep: true,
  size: [0.9, 1.7], grow: 2.3, life: [0.6, 1.2], gravity: -0.25, drag: 2.4,
  speed: 0.55, spread: 0.6, alpha: 0.9,
});
defType('cloud', {
  behav: BH_CLOUD, group: G_BLEND, tex: 'particle_cloud', lit: true,
  size: [0.22, 0.42], grow: 1.7, life: [0.6, 1.3], gravity: -0.1, drag: 2.6,
  speed: 0.5, spread: 0.2, alpha: 0.8,
});
defType('dust', {
  behav: BH_DUST, group: G_BLEND, tex: 'particle_dust', color: 0xff2a2a,
  size: [0.07, 0.13], grow: 0.7, life: [0.6, 1.5], gravity: 0.6, drag: 1.7,
  speed: 0.2, spread: 0.2, alpha: 1,
});
defType('block', {
  behav: BH_BLOCK, group: G_CUTOUT, tex: 'particle_dust', block: true,
  collide: true, lit: true, keep: true,
  size: [0.09, 0.14], grow: 1, life: [0.6, 1.7], gravity: 20, drag: 0.35,
  speed: 1.1, spread: 0.3, alpha: 1,
});
defType('sweep', {
  behav: BH_SWEEP, group: G_BLEND, tex: 'particle_sweep', keep: true,
  size: [0.7, 0.95], grow: 2.1, life: [0.28, 0.38], drag: 0, alpha: 0.5,
  spread: 0.05,
});
defType('slime', {
  behav: BH_BASIC, group: G_CUTOUT, tex: 'particle_slime', collide: true, lit: true,
  size: [0.1, 0.2], grow: 0.9, life: [0.6, 1.2], gravity: 14, drag: 0.4,
  speed: 1.0, vy: 0.6, spread: 0.25, alpha: 1,
});
defType('snowball', {
  behav: BH_BASIC, group: G_CUTOUT, tex: 'particle_generic_2', collide: true, lit: true,
  size: [0.09, 0.15], grow: 0.9, life: [0.3, 0.75], gravity: 11, drag: 0.3,
  speed: 1.2, vy: 0.5, spread: 0.2, alpha: 1,
});
defType('firework', {
  behav: BH_FIREWORK, group: G_BLEND, tex: 'particle_firework', randomColor: true,
  trail: true,
  size: [0.14, 0.24], grow: 0.45, life: [0.9, 1.9], gravity: 2.2, drag: 1.5,
  speed: 5.5, spread: 0.1, alpha: 1,
});
defType('spark', {
  behav: BH_BASIC, group: G_ADD, tex: 'particle_generic_5',
  size: [0.06, 0.1], grow: 0.25, life: [0.25, 0.55], gravity: 1.6, drag: 2.2,
  speed: 0.25, spread: 0.05, alpha: 1,
});
defType('drip_water', {
  flat: true, behav: BH_DRIP, group: G_BLEND, tex: 'particle_drip_hang', color: 0x3b6fd8, lit: true,
  size: [0.09, 0.12], grow: 1, life: [4.5, 4.5], gravity: 14, drag: 0,
  spread: 0.28, alpha: 1,
});
defType('drip_lava', {
  flat: true, behav: BH_DRIP, group: G_BLEND, tex: 'particle_drip_hang', color: 0xf07c1e,
  size: [0.1, 0.13], grow: 1, life: [4.5, 4.5], gravity: 14, drag: 0,
  spread: 0.28, alpha: 1,
});
defType('drip_honey', {
  flat: true, behav: BH_DRIP, group: G_BLEND, tex: 'particle_drip_hang', color: 0xf2a72c, lit: true,
  size: [0.1, 0.13], grow: 1, life: [5.5, 5.5], gravity: 10, drag: 0,
  spread: 0.28, alpha: 1,
});
defType('soul', {
  behav: BH_SOUL, group: G_BLEND, tex: 'particle_soul', color: 0xa8e6ff,
  size: [0.2, 0.32], grow: 0.35, life: [1.1, 2.2], gravity: -0.4, drag: 1.3,
  speed: 0.12, vy: 0.35, spread: 0.2, alpha: 1,
});
defType('end_rod', {
  behav: BH_ENDROD, group: G_BLEND, tex: 'particle_end_rod',
  size: [0.1, 0.16], grow: 0.15, life: [2.0, 4.5], gravity: -0.02, drag: 0.35,
  speed: 0.25, spread: 0.06, alpha: 1,
});
defType('totem', {
  behav: BH_TOTEM, group: G_BLEND, tex: 'particle_totem',
  count: 1, size: [0.18, 0.3], grow: 0.7, life: [1.0, 2.0], gravity: 3.0,
  drag: 1.6, speed: 3.2, spread: 0.15, spin: 5, randomSpin: true, alpha: 1,
});
defType('damage', {
  behav: BH_DAMAGE, group: G_BLEND, tex: 'particle_damage',
  size: [0.16, 0.26], grow: 1.5, life: [0.6, 1.0], gravity: 3.2, drag: 1.0,
  speed: 0.35, vy: 0.9, spread: 0.2, alpha: 0.9,
});
defType('spore', {
  behav: BH_SPORE, group: G_BLEND, tex: 'particle_spore', lit: true,
  size: [0.06, 0.1], grow: 1, life: [7.0, 14.0], gravity: 0.16, drag: 1.6,
  speed: 0.04, spread: 0.35, alpha: 0.95,
});
defType('cherry', {
  behav: BH_CHERRY, group: G_CUTOUT, tex: 'particle_cherry', lit: true,
  collide: true, dieOnGround: true,
  size: [0.11, 0.17], grow: 1, life: [7.0, 15.0], gravity: 0.55, drag: 1.1,
  speed: 0.06, spread: 0.6, spin: 2.2, randomSpin: true, alpha: 1,
});
defType('glow', {
  behav: BH_GLOW, group: G_ADD, tex: 'particle_glow', color: 0xd8ff88,
  size: [0.08, 0.13], grow: 1, life: [4.0, 9.0], gravity: 0, drag: 0.9,
  speed: 0.16, spread: 0.5, alpha: 1,
});
defType('ash', {
  behav: BH_ASH, group: G_BLEND, tex: 'particle_generic_5', color: 0xd4d0c4, lit: true,
  size: [0.05, 0.09], grow: 1, life: [6.0, 14.0], gravity: 0.22, drag: 1.4,
  speed: 0.05, spread: 0.7, alpha: 0.65,
});
defType('snowflake', {
  behav: BH_CHERRY, group: G_BLEND, tex: 'particle_snowflake', lit: true,
  collide: true, dieOnGround: true,
  size: [0.07, 0.12], grow: 1, life: [3.0, 7.0], gravity: 0.9, drag: 1.2,
  speed: 0.05, spread: 0.5, spin: 1.5, randomSpin: true, alpha: 0.9,
});
defType('sculk', {
  behav: BH_SPELL, group: G_BLEND, tex: 'particle_sculk_charge', color: 0x39e8d4,
  count: 2, size: [0.1, 0.18], grow: 0.5, life: [0.8, 1.6], gravity: -0.2,
  drag: 1.2, speed: 0.2, spread: 0.3, spin: 4, randomSpin: true, alpha: 1,
});
defType('happy', {
  behav: BH_RISE, group: G_BLEND, tex: 'particle_spell', color: 0x5cd85c,
  size: [0.16, 0.24], grow: 0.8, life: [0.8, 1.3], gravity: 1.6, drag: 1.0,
  speed: 0.15, vy: 0.8, spread: 0.3, alpha: 1,
});
defType('flash', {
  behav: BH_FLASH, group: G_ADD, tex: 'particle_flash', keep: true,
  size: [1.2, 1.6], grow: 2.4, life: [0.14, 0.22], drag: 0, alpha: 1,
});
defType('crimson_spore', {
  behav: BH_ASH, group: G_BLEND, tex: 'particle_generic_5', color: 0xdd4d4d,
  size: [0.05, 0.09], grow: 1, life: [5.0, 11.0], gravity: 0.1, drag: 1.5,
  speed: 0.05, spread: 0.7, alpha: 0.8,
});
defType('warped_spore', {
  behav: BH_ASH, group: G_BLEND, tex: 'particle_generic_5', color: 0x2fd0b8,
  size: [0.05, 0.09], grow: 1, life: [5.0, 11.0], gravity: 0.1, drag: 1.5,
  speed: 0.05, spread: 0.7, alpha: 0.8,
});
defType('mycelium', {
  behav: BH_ASH, group: G_BLEND, tex: 'particle_generic_6', color: 0x9c8ba8, lit: true,
  size: [0.04, 0.07], grow: 1, life: [1.5, 3.0], gravity: 0.05, drag: 1.8,
  speed: 0.03, spread: 0.4, alpha: 0.7,
});
defType('dragon_breath', {
  behav: BH_SPELL, group: G_BLEND, tex: 'particle_spell', color: 0xc060e0,
  count: 4, size: [0.14, 0.26], grow: 0.9, life: [1.0, 2.0], gravity: -0.1,
  drag: 1.4, speed: 0.25, spread: 0.5, alpha: 0.75,
});

// Aliases keep every caller in the project working no matter which spelling of
// a vanilla particle name it reaches for.
aliasType('critical_hit', 'crit');
aliasType('crit_magic', 'enchanted_hit');
aliasType('magic_crit', 'enchanted_hit');
aliasType('spell', 'magic');
aliasType('instant_effect', 'magic');
aliasType('entity_effect', 'magic');
aliasType('witch', 'magic');
aliasType('enchanted_glyph', 'enchant');
aliasType('enchantment_table', 'enchant');
aliasType('happy_villager', 'happy');
aliasType('composter', 'happy');
aliasType('wax_on', 'happy');
aliasType('wax_off', 'happy');
aliasType('scrape', 'happy');
aliasType('villager_happy', 'happy');
aliasType('villager_angry', 'angry');
aliasType('poof', 'cloud');
aliasType('explosion_emitter', 'explosion');
aliasType('explosion_large', 'explosion');
aliasType('explosion_huge', 'explosion');
aliasType('smoke_large', 'large_smoke');
aliasType('smoke_normal', 'smoke');
aliasType('campfire_cosy_smoke', 'campfire_smoke');
aliasType('campfire_signal_smoke', 'campfire_smoke');
aliasType('flame_small', 'flame');
aliasType('small_flame', 'flame');
aliasType('soul_fire_flame', 'soul');
aliasType('lava_pop', 'lava');
aliasType('drip', 'drip_water');
aliasType('water_drip', 'drip_water');
aliasType('dripping_water', 'drip_water');
aliasType('falling_water', 'drip_water');
aliasType('landing_water', 'splash');
aliasType('dripping_lava', 'drip_lava');
aliasType('falling_lava', 'drip_lava');
aliasType('landing_lava', 'drip_lava');
aliasType('dripping_honey', 'drip_honey');
aliasType('falling_honey', 'drip_honey');
aliasType('dripping_dripstone_water', 'drip_water');
aliasType('falling_dripstone_water', 'drip_water');
aliasType('dripping_dripstone_lava', 'drip_lava');
aliasType('falling_dripstone_lava', 'drip_lava');
aliasType('splash_water', 'splash');
aliasType('water_splash', 'splash');
aliasType('bubble_pop', 'bubble');
aliasType('bubble_column_up', 'bubble');
aliasType('underwater', 'bubble');
aliasType('water_bubble', 'bubble');
aliasType('sweep_attack', 'sweep');
aliasType('item_slime', 'slime');
aliasType('item_snowball', 'snowball');
aliasType('snow', 'snowflake');
aliasType('white_ash', 'ash');
aliasType('falling_dust', 'ash');
aliasType('firefly', 'glow');
aliasType('glow_squid_ink', 'glow');
aliasType('spore_blossom_air', 'spore');
aliasType('cherry_leaves', 'cherry');
aliasType('note_block', 'note');
aliasType('portal_reverse', 'portal');
aliasType('nether_portal', 'portal');
aliasType('sculk_charge', 'sculk');
aliasType('sculk_soul', 'soul');
aliasType('soul_flame', 'soul');
aliasType('totem_of_undying', 'totem');
aliasType('damage_indicator', 'damage');
aliasType('electric_spark', 'spark');
aliasType('firework_spark', 'spark');
aliasType('dust_color_transition', 'dust');
aliasType('redstone', 'dust');
aliasType('reverse_portal', 'portal');
aliasType('end_rod_glow', 'end_rod');
aliasType('block_dust', 'block');
aliasType('item', 'block');
aliasType('block_crack', 'block');
aliasType('rain_splash', 'rain');

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------
const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iUv;
attribute vec3 iColor;
attribute vec2 iSizeAngle;
attribute float iAlpha;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;

void main() {
  float sz = iSizeAngle.x;
  float ang = iSizeAngle.y;
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 corner = position.xy * sz;
  vec2 spun = vec2(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca);
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  mvPosition.xy += spun;
  vDepth = -mvPosition.z;
  vUv = iUv.xy + uv * iUv.zw;
  vColor = iColor;
  vAlpha = iAlpha;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogDensity;
uniform float uFogMode;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666667)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec4 texel = texture2D(uMap, vUv);
  #ifdef CUTOUT
    if (texel.a < 0.5) discard;
  #endif
  float a = texel.a * vAlpha;
  if (a < 0.004) discard;

  vec3 col = srgbToLinear(texel.rgb) * vColor;

  float f = 0.0;
  if (uFogMode > 1.5) {
    float d = uFogDensity * vDepth;
    f = 1.0 - exp(-d * d);
  } else if (uFogMode > 0.5) {
    f = clamp((vDepth - uFogNear) / max(uFogFar - uFogNear, 0.0001), 0.0, 1.0);
  }
  #ifdef ADDITIVE
    col *= (1.0 - f);
  #else
    col = mix(col, uFogColor, f);
  #endif

  #ifdef ENCODE_SRGB
    col = linearToSrgb(col);
  #endif
  gl_FragColor = vec4(col, a);
}
`;

// ---------------------------------------------------------------------------
// A render family: one instanced quad mesh with its own instance buffers.
// ---------------------------------------------------------------------------
const QUAD_POS = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
// flipY is false on the atlas, so v grows downward: the top corners take v = 0.
const QUAD_UV = [0, 1, 1, 1, 1, 0, 0, 0];
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

/** Marks the used prefix of a dynamic attribute for upload. */
function markRange(attr, items) {
  if (items <= 0) return;
  attr.needsUpdate = true;
  if (typeof attr.clearUpdateRanges === 'function' && typeof attr.addUpdateRange === 'function') {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, items * attr.itemSize);
  } else if (attr.updateRange) {
    attr.updateRange.offset = 0;
    attr.updateRange.count = items * attr.itemSize;
  }
}

class ParticleGroup {
  constructor(scene, material, max, renderOrder) {
    this.max = max;
    this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.uv = new Float32Array(max * 4);
    this.col = new Float32Array(max * 3);
    this.sa = new Float32Array(max * 2);
    this.alpha = new Float32Array(max);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(QUAD_POS.slice(), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(QUAD_UV.slice(), 2));
    g.setIndex(QUAD_INDEX.slice());
    const dyn = THREE.DynamicDrawUsage;
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(dyn);
    this.aUv = new THREE.InstancedBufferAttribute(this.uv, 4).setUsage(dyn);
    this.aCol = new THREE.InstancedBufferAttribute(this.col, 3).setUsage(dyn);
    this.aSa = new THREE.InstancedBufferAttribute(this.sa, 2).setUsage(dyn);
    this.aAlpha = new THREE.InstancedBufferAttribute(this.alpha, 1).setUsage(dyn);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iUv', this.aUv);
    g.setAttribute('iColor', this.aCol);
    g.setAttribute('iSizeAngle', this.aSa);
    g.setAttribute('iAlpha', this.aAlpha);
    g.instanceCount = 0;
    // The mesh never moves, so a fixed sphere keeps three from computing one.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    this.geometry = g;

    const mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = renderOrder;
    mesh.name = 'particles';
    this.mesh = mesh;
    if (scene && scene.add) scene.add(mesh);
  }

  push(x, y, z, u, v, du, dv, r, g, b, size, angle, alpha) {
    const n = this.n;
    if (n >= this.max) return;
    const i3 = n * 3, i4 = n * 4, i2 = n * 2;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.uv[i4] = u; this.uv[i4 + 1] = v; this.uv[i4 + 2] = du; this.uv[i4 + 3] = dv;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.sa[i2] = size; this.sa[i2 + 1] = angle;
    this.alpha[n] = alpha;
    this.n = n + 1;
  }

  commit() {
    this.geometry.instanceCount = this.n;
    if (this.n > 0) {
      markRange(this.aPos, this.n);
      markRange(this.aUv, this.n);
      markRange(this.aCol, this.n);
      markRange(this.aSa, this.n);
      markRange(this.aAlpha, this.n);
    }
  }

  dispose(scene) {
    if (scene && scene.remove) scene.remove(this.mesh);
    this.geometry.dispose();
    if (this.mesh.material && this.mesh.material.dispose) this.mesh.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Shared quality state, refreshed once a frame from the settings module.
// ---------------------------------------------------------------------------
let _quality = 1;        // multiplier applied to every requested particle count
let _ambientQuality = 1; // multiplier applied to ambient emitters only

function refreshQuality() {
  let mode = 'all';
  try {
    const s = Game.settings;
    if (s && typeof s.get === 'function') mode = s.get('particles') || 'all';
  } catch { mode = 'all'; }
  if (mode === 'minimal') { _quality = 0.25; _ambientQuality = 0; }
  else if (mode === 'decreased') { _quality = 0.55; _ambientQuality = 0.4; }
  else { _quality = 1; _ambientQuality = 1; }
}

// ---------------------------------------------------------------------------
// World probes (all defensive: an unloaded chunk or a half-built world module
// must never throw out of the particle update).
// ---------------------------------------------------------------------------
function blockAt(world, x, y, z) {
  if (!world) return 0;
  const yi = Math.floor(y);
  if (yi < 0 || yi >= WORLD_HEIGHT) return 0;
  try { return world.getBlock(Math.floor(x), yi, Math.floor(z)) | 0; } catch { return 0; }
}

function solidAt(world, x, y, z) {
  const id = blockAt(world, x, y, z);
  if (id === 0) return false;
  const def = blockDefOf(id);
  if (def.liquid) return false;
  return blockIsSolid(id) && def.collision !== 'none';
}

/** 'water' | 'lava' | null for the block containing this point. */
function liquidAt(world, x, y, z) {
  const id = blockAt(world, x, y, z);
  return id === 0 ? null : (blockDefOf(id).liquid || null);
}

function lightAt(world, x, y, z) {
  if (!world) return 1;
  const yi = Math.floor(y);
  if (yi < 0) return LIGHT_LUT[0];
  if (yi >= WORLD_HEIGHT) return 1;
  let l = 15;
  try { l = world.getLight(Math.floor(x), yi, Math.floor(z)); } catch { l = 15; }
  const i = l < 0 ? 0 : l > 15 ? 15 : l | 0;
  return LIGHT_LUT[i];
}

/** Biome tint for a tinted block, so grass and leaf particles match the world. */
function tintFor(world, def, x, z) {
  const t = def && def.tint;
  if (!t) return 0xffffff;
  if (typeof t === 'number') return t;
  if (t === 'birch') return 0x80a755;
  if (t === 'spruce') return 0x619961;
  let biome = null;
  try { biome = world && world.biomeAt ? world.biomeAt(Math.floor(x), Math.floor(z)) : null; } catch { biome = null; }
  if (!biome) return t === 'water' ? 0x3f76e4 : 0x79c05a;
  if (t === 'grass') return biome.grassColor ?? 0x79c05a;
  if (t === 'foliage') return biome.foliageColor ?? 0x59ae30;
  if (t === 'water') return biome.waterColor ?? 0x3f76e4;
  if (t === 'redstone') return 0xff3030;
  return 0xffffff;
}

/**
 * Whether a given face of a block carries its biome tint. Grass blocks only
 * tint their top, so a shard off the side must stay dirt-coloured.
 */
function faceTinted(def, face) {
  if (!def || !def.tint) return false;
  const tf = def.tintFaces;
  if (!tf || !tf.length) return true;
  for (let k = 0; k < tf.length; k++) if ((tf[k] | 0) === face) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------
export class Particles {
  /**
   * @param {THREE.Scene} scene  scene the three render families are added to
   * @param {{max?: number}} [opts]
   */
  constructor(scene, opts = {}) {
    this.scene = scene || null;
    const max = Math.max(64, Math.min(65536, opts.max || DEFAULT_MAX));
    this.max = max;

    const F = () => new Float32Array(max);
    // --- simulation state ---
    this.x = F(); this.y = F(); this.z = F();
    this.vx = F(); this.vy = F(); this.vz = F();
    this.ox = F(); this.oy = F(); this.oz = F();     // spawn origin (swirls, streams)
    this.grav = F(); this.dragK = F();
    this.age = F(); this.life = F();
    this.size0 = F(); this.size1 = F();
    this.rot = F(); this.rotv = F();
    this.cr = F(); this.cg = F(); this.cb = F();     // base colour, linear
    this.alpha = F();
    this.u0 = F(); this.v0 = F(); this.du = F(); this.dv = F();
    this.d0 = F(); this.d1 = F();                    // behaviour scratch
    this.seed = F();
    this.lightMul = F();
    // --- per-frame render output ---
    this.rs = F(); this.ra = F();
    this.rr = F(); this.rg = F(); this.rb = F();
    this.behav = new Uint8Array(max);
    this.group = new Uint8Array(max);
    this.flags = new Uint8Array(max);

    // --- pool bookkeeping ---
    this.free = new Int32Array(max);
    for (let i = 0; i < max; i++) this.free[i] = max - 1 - i;
    this.freeCount = max;
    this.live = new Int32Array(max);
    this.liveCount = 0;

    this.rng = new RNG(0x9e3779b9);
    this.frames = 0;
    this._camera = null;

    // --- GPU side ---
    const map = atlasTexture();
    const fogU = {
      uFogColor: { value: new THREE.Color(0.7, 0.8, 1.0) },
      uFogNear: { value: 1 },
      uFogFar: { value: 1000 },
      uFogDensity: { value: 0 },
      uFogMode: { value: 0 },
    };
    this._fogU = fogU;
    const encode = encodesSrgb();
    this.groups = [
      new ParticleGroup(this.scene, makeMaterial(G_CUTOUT, map, fogU, encode), max, 3),
      new ParticleGroup(this.scene, makeMaterial(G_BLEND, map, fogU, encode), max, 3010),
      new ParticleGroup(this.scene, makeMaterial(G_ADD, map, fogU, encode), max, 3020),
    ];

    this._offs = [];
    this._hookEvents();
  }

  /** How many particles are alive right now. */
  get count() { return this.liveCount; }

  // -- event hooks ----------------------------------------------------------
  // Block breaking and mining chips are pushed by player.js / blockupdate.js
  // directly, so the only thing worth listening for is the death poof that
  // nothing else owns.
  _hookEvents() {
    const on = (name, fn) => {
      try {
        const off = Game.on(name, fn);
        if (typeof off === 'function') this._offs.push(off);
      } catch { /* the bus is optional */ }
    };
    on('entitydeath', (entity) => {
      if (!entity || entity === Game.player) return;
      const h = entity.height || 1;
      try {
        this.spawn('cloud', entity.x, entity.y + h * 0.5, entity.z,
          { count: 10, spread: Math.max(0.2, (entity.width || 0.6) * 0.5) });
      } catch { /* optional */ }
    });
  }

  // -- pool -----------------------------------------------------------------
  /** Pops a free index and registers it as live, or -1 when the pool is full. */
  _alloc() {
    if (this.freeCount <= 0) return -1;
    const i = this.free[--this.freeCount];
    this.live[this.liveCount++] = i;
    return i;
  }

  /** Frees the particle occupying live slot `k` (swap-remove, order-free). */
  _killSlot(k) {
    const i = this.live[k];
    const last = --this.liveCount;
    this.live[k] = this.live[last];
    this.free[this.freeCount++] = i;
  }

  // -- spawning -------------------------------------------------------------
  /**
   * Spawns particles of `type` at a world position.
   * @param {string} type  one of the names in the contract (aliases accepted)
   * @param {number} x @param {number} y @param {number} z
   * @param {object} [opts] { count, vx, vy, vz, spread, color, size, life,
   *                          gravity, block, meta, speed, alpha, collide }
   * @returns {number} how many particles were actually created
   */
  spawn(type, x, y, z, opts = {}) {
    const t = typeOf(type) || TYPES.get('cloud');
    if (!t) return 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;

    const rng = this.rng;
    let want = opts.count != null ? opts.count : t.count;
    if (!(want > 0)) return 0;
    if (_quality < 1) {
      const scaled = want * _quality;
      want = Math.floor(scaled);
      if (rng.next() < scaled - want) want++;
      if (want < 1 && t.keep) want = 1;
      if (want < 1) return 0;
    }
    if (want > 256) want = 256;

    const world = Game.world || null;
    // Block particles resolve their texture (and biome tint) once per call.
    let blockTex = null, blockTint = 0xffffff;
    if (t.block) {
      const bid = ((opts.block != null ? opts.block : opts.blockId) | 0) || 0;
      if (bid > 0) {
        const def = blockDefOf(bid);
        let meta = opts.meta | 0;
        if (!opts.meta && world) {
          try {
            if (world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === bid) {
              meta = world.getMeta(Math.floor(x), Math.floor(y), Math.floor(z));
            }
          } catch { meta = 0; }
        }
        blockTex = safeTexture(bid, meta, 2);
        if (faceTinted(def, 2)) blockTint = tintFor(world, def, x, z);
      }
    }

    const rect = uvRect(t.tex);
    let spread = opts.spread != null ? opts.spread : t.spread;
    let sizeOverride = opts.size;
    // combat.js and mobs.js hand explosions their blast power as `size`. One
    // 4-block billboard reads as a poster, so bloom it into a cloud of smaller
    // puffs the way the vanilla explosion emitter does.
    if (t.behav === BH_EXPLODE && sizeOverride > 0.9) {
      const power = sizeOverride;
      want = Math.min(64, Math.round(want * (2 + power * 1.6) * (_quality < 1 ? _quality : 1)));
      if (want < 1) want = 1;
      sizeOverride = 0.35 + power * 0.28;
      spread = Math.max(spread, power * 0.45);
    }
    const speed = opts.speed != null ? opts.speed : t.speed;
    const gravity = opts.gravity != null ? opts.gravity : t.gravity;
    // An explicit vy replaces the type's launch speed rather than stacking on
    // top of it, which is what every call site in the project expects.
    const bvx = opts.vx || 0, bvy = opts.vy != null ? opts.vy : t.vy, bvz = opts.vz || 0;
    const baseAlpha = opts.alpha != null ? opts.alpha : t.alpha;

    let made = 0;
    for (let n = 0; n < want; n++) {
      const i = this._alloc();
      if (i < 0) break;
      made++;

      // --- position ---
      let px = x, py = y, pz = z;
      if (spread > 0) {
        px += (rng.next() * 2 - 1) * spread;
        if (!t.flat) py += (rng.next() * 2 - 1) * spread;
        pz += (rng.next() * 2 - 1) * spread;
      }
      if (t.behav === BH_ENCHANT || t.behav === BH_PORTAL) {
        // These two start away from the emitter and travel back to it.
        this.ox[i] = x; this.oy[i] = y; this.oz[i] = z;
      } else {
        this.ox[i] = px; this.oy[i] = py; this.oz[i] = pz;
      }
      this.x[i] = px; this.y[i] = py; this.z[i] = pz;

      // --- velocity ---
      let vx = bvx, vy = bvy, vz = bvz;
      if (speed > 0) {
        const th = rng.next() * TAU;
        const ph = Math.acos(rng.next() * 2 - 1);
        const m = speed * (0.35 + rng.next() * 0.65);
        vx += Math.sin(ph) * Math.cos(th) * m;
        vy += Math.cos(ph) * m * 0.7;
        vz += Math.sin(ph) * Math.sin(th) * m;
      }
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;

      // --- shape & timing ---
      this.grav[i] = gravity;
      this.dragK[i] = opts.drag != null ? opts.drag : t.drag;
      const life = opts.life != null
        ? opts.life * (0.85 + rng.next() * 0.3)
        : t.lifeMin + rng.next() * (t.lifeMax - t.lifeMin);
      this.life[i] = Math.max(0.05, life);
      this.age[i] = 0;
      const s0 = sizeOverride != null
        ? sizeOverride * (0.85 + rng.next() * 0.3)
        : t.sizeMin + rng.next() * (t.sizeMax - t.sizeMin);
      this.size0[i] = s0;
      this.size1[i] = s0 * t.grow;
      this.rot[i] = t.randomSpin ? rng.next() * TAU : 0;
      this.rotv[i] = t.spin ? (rng.next() * 2 - 1) * t.spin : 0;
      this.seed[i] = rng.next();
      this.d0[i] = 0; this.d1[i] = 0;

      // --- colour ---
      let hex;
      if (opts.color != null) hex = opts.color | 0;
      else if (t.block) hex = blockTint;
      else if (t.randomColor) {
        const rgbv = hsvToRgb(rng.next(), 0.75, 1);
        hex = (Math.round(rgbv[0] * 255) << 16) | (Math.round(rgbv[1] * 255) << 8) | Math.round(rgbv[2] * 255);
      } else hex = t.color;
      this.cr[i] = linR(hex); this.cg[i] = linG(hex); this.cb[i] = linB(hex);
      this.alpha[i] = baseAlpha;

      // --- texture ---
      if (blockTex) {
        subRect(blockTex, rng.int(4) * 4, rng.int(4) * 4, _sub);
        this.u0[i] = _sub[0]; this.v0[i] = _sub[1]; this.du[i] = _sub[2]; this.dv[i] = _sub[3];
      } else {
        this.u0[i] = rect[0]; this.v0[i] = rect[1]; this.du[i] = rect[2]; this.dv[i] = rect[3];
      }

      // --- flags ---
      let fl = 0;
      const collide = opts.collide != null ? !!opts.collide : t.collide;
      if (collide) fl |= F_COLLIDE;
      if (t.lit) fl |= F_LIT;
      if (t.dieOnGround) fl |= F_DIE_ON_GROUND;
      if (t.water) fl |= F_WATER_ONLY;
      if (t.trail) fl |= F_TRAIL;
      this.flags[i] = fl;
      this.behav[i] = t.behav;
      this.group[i] = t.group;
      this.lightMul[i] = (fl & F_LIT) ? lightAt(world, px, py, pz) : 1;

      // Behaviours that need a bespoke launch.
      this._launch(i, t, opts, rng);

      // Seed the render fields so a particle spawned after the sim step still
      // draws correctly on this frame.
      this.rs[i] = s0;
      this.ra[i] = baseAlpha;
      const lm = this.lightMul[i];
      this.rr[i] = this.cr[i] * lm; this.rg[i] = this.cg[i] * lm; this.rb[i] = this.cb[i] * lm;
    }
    return made;
  }

  /** Per-behaviour spawn tweaks that need more than the generic parameters. */
  _launch(i, t, opts, rng) {
    switch (t.behav) {
      case BH_ENCHANT: {
        // Start on a shell around the target and fall inward.
        const r = (opts.spread != null ? opts.spread : t.spread) * (0.6 + rng.next() * 0.4);
        const th = rng.next() * TAU;
        const ph = Math.acos(rng.next() * 2 - 1);
        this.x[i] = this.ox[i] + Math.sin(ph) * Math.cos(th) * r;
        this.y[i] = this.oy[i] + Math.cos(ph) * r * 0.7 + 0.4;
        this.z[i] = this.oz[i] + Math.sin(ph) * Math.sin(th) * r;
        this.d0[i] = this.x[i] - this.ox[i];
        this.d1[i] = this.z[i] - this.oz[i];
        this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
        break;
      }
      case BH_PORTAL: {
        this.d0[i] = this.x[i] - this.ox[i];
        this.d1[i] = this.z[i] - this.oz[i];
        this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
        break;
      }
      case BH_SPELL:
      case BH_CRIT:
      case BH_TOTEM: {
        // Remember the launch radius/angle so the swirl has a centre.
        this.d0[i] = Math.atan2(this.z[i] - this.oz[i], this.x[i] - this.ox[i]);
        this.d1[i] = Math.hypot(this.x[i] - this.ox[i], this.z[i] - this.oz[i]);
        break;
      }
      case BH_DRIP: {
        // phase 0 = hanging, 1 = falling, 2 = landed
        this.d0[i] = 0;
        this.d1[i] = 0.4 + rng.next() * 1.6;   // hang time
        this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
        break;
      }
      case BH_SWEEP: {
        this.rot[i] = (opts.angle != null ? opts.angle : 0);
        break;
      }
      case BH_RAIN: {
        this.vy[i] = -8 - rng.next() * 4;
        break;
      }
      default: break;
    }
  }

  /**
   * The classic block-break burst: 8-16 textured cubes carved out of the
   * block's own atlas tile.
   */
  blockBreak(x, y, z, blockId) {
    const id = blockId | 0;
    if (id <= 0) return 0;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const world = Game.world || null;
    let meta = 0;
    try { if (world && world.getBlock(bx, by, bz) === id) meta = world.getMeta(bx, by, bz); } catch { meta = 0; }
    const def = blockDefOf(id);
    const tint = def.tint ? tintFor(world, def, bx, bz) : 0xffffff;
    const tr = linR(tint), tg = linG(tint), tb = linB(tint);

    const rng = this.rng;
    let want = 8 + rng.int(9);
    if (_quality < 1) want = Math.max(3, Math.round(want * _quality));
    const light = lightAt(world, bx + 0.5, by + 0.5, bz + 0.5);

    let made = 0;
    for (let n = 0; n < want; n++) {
      const i = this._alloc();
      if (i < 0) break;
      made++;
      const fx = rng.next(), fy = rng.next(), fz = rng.next();
      const px = bx + fx, py = by + fy, pz = bz + fz;
      this.x[i] = px; this.y[i] = py; this.z[i] = pz;
      this.ox[i] = px; this.oy[i] = py; this.oz[i] = pz;
      // Push outward from the block centre, plus a hop.
      this.vx[i] = (fx - 0.5) * 3.4 + (rng.next() - 0.5) * 0.6;
      this.vy[i] = (fy - 0.5) * 2.2 + 2.2 + rng.next() * 1.2;
      this.vz[i] = (fz - 0.5) * 3.4 + (rng.next() - 0.5) * 0.6;
      this.grav[i] = 20;
      this.dragK[i] = 0.35;
      this.age[i] = 0;
      this.life[i] = 0.6 + rng.next() * 1.1;
      const s = 0.085 + rng.next() * 0.06;
      this.size0[i] = s; this.size1[i] = s;
      this.rot[i] = 0; this.rotv[i] = 0;
      const face = rng.int(6);
      const ft = faceTinted(def, face);
      this.cr[i] = ft ? tr : 1; this.cg[i] = ft ? tg : 1; this.cb[i] = ft ? tb : 1;
      this.alpha[i] = 1;
      subRect(safeTexture(id, meta, face), rng.int(4) * 4, rng.int(4) * 4, _sub);
      this.u0[i] = _sub[0]; this.v0[i] = _sub[1]; this.du[i] = _sub[2]; this.dv[i] = _sub[3];
      this.behav[i] = BH_BLOCK;
      this.group[i] = G_CUTOUT;
      this.flags[i] = F_COLLIDE | F_LIT;
      this.seed[i] = rng.next();
      this.d0[i] = 0; this.d1[i] = 0;
      this.lightMul[i] = light;
      this.rs[i] = s; this.ra[i] = 1;
      this.rr[i] = this.cr[i] * light; this.rg[i] = this.cg[i] * light; this.rb[i] = this.cb[i] * light;
    }
    return made;
  }

  /**
   * A few chips off the face being hit. `face` may be a FACE_* index, a face
   * name, or -1/undefined for "pick one".
   */
  blockHit(x, y, z, blockId, face) {
    const id = blockId | 0;
    if (id <= 0) return 0;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const world = Game.world || null;
    let meta = 0;
    try { if (world && world.getBlock(bx, by, bz) === id) meta = world.getMeta(bx, by, bz); } catch { meta = 0; }
    const def = blockDefOf(id);

    let f = typeof face === 'string' ? FACE_NAMES.indexOf(face) : (face | 0);
    if (!(f >= 0 && f <= 5)) f = 1;
    const tint = faceTinted(def, f) ? tintFor(world, def, bx, bz) : 0xffffff;
    const dir = FACE_DIRS[f];
    const rng = this.rng;
    let want = 2 + rng.int(3);
    if (_quality < 1) want = Math.max(1, Math.round(want * _quality));
    const light = lightAt(world, bx + 0.5, by + 0.5, bz + 0.5);

    let made = 0;
    for (let n = 0; n < want; n++) {
      const i = this._alloc();
      if (i < 0) break;
      made++;
      // Sit just outside the struck face, jittered across it.
      const jx = dir[0] !== 0 ? (dir[0] > 0 ? 1.06 : -0.06) : 0.14 + rng.next() * 0.72;
      const jy = dir[1] !== 0 ? (dir[1] > 0 ? 1.06 : -0.06) : 0.14 + rng.next() * 0.72;
      const jz = dir[2] !== 0 ? (dir[2] > 0 ? 1.06 : -0.06) : 0.14 + rng.next() * 0.72;
      const px = bx + jx, py = by + jy, pz = bz + jz;
      this.x[i] = px; this.y[i] = py; this.z[i] = pz;
      this.ox[i] = px; this.oy[i] = py; this.oz[i] = pz;
      this.vx[i] = dir[0] * (0.9 + rng.next()) + (rng.next() - 0.5) * 0.9;
      this.vy[i] = dir[1] * (0.9 + rng.next()) + 1.1 + rng.next() * 0.7;
      this.vz[i] = dir[2] * (0.9 + rng.next()) + (rng.next() - 0.5) * 0.9;
      this.grav[i] = 18;
      this.dragK[i] = 0.4;
      this.age[i] = 0;
      this.life[i] = 0.35 + rng.next() * 0.5;
      const s = 0.06 + rng.next() * 0.05;
      this.size0[i] = s; this.size1[i] = s;
      this.rot[i] = 0; this.rotv[i] = 0;
      this.cr[i] = linR(tint); this.cg[i] = linG(tint); this.cb[i] = linB(tint);
      this.alpha[i] = 1;
      subRect(safeTexture(id, meta, f), rng.int(4) * 4, rng.int(4) * 4, _sub);
      this.u0[i] = _sub[0]; this.v0[i] = _sub[1]; this.du[i] = _sub[2]; this.dv[i] = _sub[3];
      this.behav[i] = BH_BLOCK;
      this.group[i] = G_CUTOUT;
      this.flags[i] = F_COLLIDE | F_LIT;
      this.seed[i] = rng.next();
      this.d0[i] = 0; this.d1[i] = 0;
      this.lightMul[i] = light;
      this.rs[i] = s; this.ra[i] = 1;
      this.rr[i] = this.cr[i] * light; this.rg[i] = this.cg[i] * light; this.rb[i] = this.cb[i] * light;
    }
    return made;
  }

  // -- frame ----------------------------------------------------------------
  /**
   * Advances the simulation and refreshes the GPU buffers.
   * @param {number} dt seconds
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    if (this.groups.length === 0) return;      // disposed
    if (camera) this._camera = camera;
    this.frames++;
    refreshQuality();
    this._syncFog();
    this._syncAtlas();

    const frozen = Game.paused === true || !(dt > 0);
    if (!frozen) {
      const step = dt > 0.1 ? 0.1 : dt;
      this._simulate(step);
      try { emitAmbient(this, Game.world, Game.player, step); } catch { /* ambience is optional */ }
    }
    this._fill();
  }

  /** Picks the atlas texture up if it was still being painted at construction. */
  _syncAtlas() {
    const m0 = this.groups[0].mesh.material;
    if (m0.uniforms.uMap.value) return;
    const tex = Atlas && Atlas.texture ? Atlas.texture : null;
    if (!tex) return;
    for (let g = 0; g < GROUP_COUNT; g++) this.groups[g].mesh.material.uniforms.uMap.value = tex;
  }

  _syncFog() {
    const u = this._fogU;
    const fog = this.scene ? this.scene.fog : null;
    if (!fog) { u.uFogMode.value = 0; return; }
    if (fog.isFogExp2 || fog.density !== undefined) {
      u.uFogMode.value = 2;
      u.uFogDensity.value = fog.density || 0;
    } else {
      u.uFogMode.value = 1;
      u.uFogNear.value = fog.near || 0;
      u.uFogFar.value = fog.far || 1000;
    }
    if (fog.color) u.uFogColor.value.copy(fog.color);
  }

  _simulate(dt) {
    const world = Game.world || null;
    const frame = this.frames;
    let k = 0;
    while (k < this.liveCount) {
      const i = this.live[k];
      if (this._step(i, dt, world, frame)) k++;
      else this._killSlot(k);
    }
  }

  /** One particle, one step. Returns false when it should die. */
  _step(i, dt, world, frame) {
    const age = this.age[i] + dt;
    this.age[i] = age;
    const life = this.life[i];
    const bh = this.behav[i];
    if (age >= life && bh !== BH_DRIP) return false;
    let t = age / life;
    if (t > 1) t = 1;

    const sd = this.seed[i];
    const phase = sd * TAU;
    let sizeMul = 1;
    let alphaMul = fadeOut(t, 0.62);
    let tintR = 1, tintG = 1, tintB = 1;
    let grav = this.grav[i];
    let doIntegrate = true;

    switch (bh) {
      case BH_SMOKE: {
        // Wander sideways as it climbs, and thin out.
        const w = Math.sin(age * 1.9 + phase) * 0.16;
        this.vx[i] += w * dt;
        this.vz[i] += Math.cos(age * 1.7 + phase) * 0.16 * dt;
        alphaMul = Math.min(1, t * 8) * (1 - t * t);
        break;
      }
      case BH_CAMPFIRE: {
        this.vx[i] += Math.sin(age * 0.7 + phase) * 0.12 * dt;
        this.vz[i] += Math.cos(age * 0.55 + phase) * 0.12 * dt;
        alphaMul = Math.min(1, t * 12) * (1 - smoothstep01(clamp((t - 0.55) / 0.45, 0, 1)));
        break;
      }
      case BH_FLAME: {
        // Flicker in both size and hue; embers cool as they rise.
        const fl = 0.82 + 0.28 * Math.sin(age * 34 + phase * 5);
        sizeMul = fl;
        const cool = t * t;
        tintR = 1;
        tintG = 1 - cool * 0.45;
        tintB = 1 - cool * 0.8;
        alphaMul = 1 - t * t * t;
        break;
      }
      case BH_LAVA: {
        sizeMul = 0.85 + 0.3 * Math.sin(age * 22 + phase * 5);
        tintG = 1 - t * 0.35;
        tintB = 1 - t * 0.6;
        alphaMul = fadeOut(t, 0.7);
        if ((this.flags[i] & F_ON_GROUND) !== 0 && t > 0.2) {
          this.spawn('smoke', this.x[i], this.y[i] + 0.05, this.z[i], { count: 1, spread: 0.05 });
          return false;
        }
        break;
      }
      case BH_BUBBLE: {
        this.vx[i] += Math.sin(age * 6 + phase) * 0.5 * dt;
        this.vz[i] += Math.cos(age * 5.3 + phase) * 0.5 * dt;
        alphaMul = fadeOut(t, 0.8);
        break;
      }
      case BH_SPLASH: {
        alphaMul = fadeOut(t, 0.5);
        break;
      }
      case BH_RAIN: {
        sizeMul = 1;
        alphaMul = 0.85;
        break;
      }
      case BH_CRIT: {
        sizeMul = 1;
        this.rot[i] += this.rotv[i] * dt;
        alphaMul = 1 - t * t;
        break;
      }
      case BH_SPELL: {
        // Orbit the emitter while drifting in and up.
        const ang = this.d0[i] + age * 3.4;
        const rad = this.d1[i] * (1 - t * 0.85);
        this.x[i] = this.ox[i] + Math.cos(ang) * rad;
        this.z[i] = this.oz[i] + Math.sin(ang) * rad;
        this.y[i] += (this.vy[i] - grav * age) * dt;
        this.rot[i] += this.rotv[i] * dt;
        alphaMul = Math.min(1, t * 6) * (1 - t * t);
        doIntegrate = false;
        break;
      }
      case BH_ENCHANT: {
        // Glyphs rush inward and wink out on arrival.
        const e = 1 - t;
        const ease = e * e;
        this.x[i] = this.ox[i] + this.d0[i] * ease;
        this.z[i] = this.oz[i] + this.d1[i] * ease;
        this.y[i] = this.oy[i] + (0.4 + this.d1[i] * 0.2) * ease + t * 0.15;
        this.rot[i] += this.rotv[i] * dt;
        sizeMul = 0.35 + ease * 0.9;
        alphaMul = Math.min(1, t * 5) * Math.min(1, e * 3.5);
        doIntegrate = false;
        break;
      }
      case BH_HEART: {
        this.x[i] += Math.sin(age * 3 + phase) * 0.09 * dt;
        this.z[i] += Math.cos(age * 2.6 + phase) * 0.09 * dt;
        sizeMul = 1 + Math.sin(age * 5 + phase) * 0.06;
        alphaMul = fadeOut(t, 0.7);
        break;
      }
      case BH_ANGRY: {
        sizeMul = 1 + Math.sin(age * 7 + phase) * 0.08;
        alphaMul = fadeOut(t, 0.6);
        break;
      }
      case BH_NOTE: {
        this.x[i] += Math.sin(age * 4 + phase) * 0.12 * dt;
        alphaMul = fadeOut(t, 0.55);
        break;
      }
      case BH_PORTAL: {
        // Streams back into the portal it came from.
        const e = 1 - t;
        const ease = e * e * e;
        this.x[i] = this.ox[i] + this.d0[i] * ease + Math.sin(age * 5 + phase) * 0.06;
        this.z[i] = this.oz[i] + this.d1[i] * ease + Math.cos(age * 4.6 + phase) * 0.06;
        this.y[i] = this.oy[i] + (this.d0[i] * 0.2 + this.d1[i] * 0.2) * ease + t * 0.35;
        sizeMul = 0.4 + ease * 0.9;
        alphaMul = Math.min(1, t * 5) * Math.min(1, e * 4);
        doIntegrate = false;
        break;
      }
      case BH_EXPLODE: {
        sizeMul = 1;
        alphaMul = Math.min(1, t * 10) * (1 - t) * (1 - t * 0.5);
        break;
      }
      case BH_CLOUD: {
        alphaMul = Math.min(1, t * 8) * (1 - t * t);
        break;
      }
      case BH_DUST: {
        sizeMul = 0.85 + 0.3 * Math.sin(age * 12 + phase * 3);
        alphaMul = fadeOut(t, 0.5);
        break;
      }
      case BH_BLOCK: {
        this.rot[i] += this.rotv[i] * dt;
        alphaMul = fadeOut(t, 0.75);
        break;
      }
      case BH_SWEEP: {
        // A single wide arc that snaps open then vanishes.
        sizeMul = 1;
        alphaMul = (1 - t) * (1 - t);
        doIntegrate = false;
        break;
      }
      case BH_FIREWORK: {
        if ((this.flags[i] & F_TRAIL) !== 0) {
          this.d0[i] += dt;
          if (this.d0[i] > 0.035 && t < 0.75) {
            this.d0[i] = 0;
            this.spawn('spark', this.x[i], this.y[i], this.z[i], {
              count: 1,
              color: hexOfLinear(this.cr[i], this.cg[i], this.cb[i]),
              spread: 0.01,
            });
          }
        }
        // Twinkle out at the end.
        alphaMul = t < 0.6 ? 1 : (0.5 + 0.5 * Math.sin(age * 45 + phase * 7)) * fadeOut(t, 0.6);
        break;
      }
      case BH_DRIP: {
        doIntegrate = false;
        const ph = this.d0[i];
        if (ph === 0) {
          // Hang and swell under the block.
          this.d1[i] -= dt;
          sizeMul = 0.8 + 0.25 * Math.sin(age * 9 + phase);
          alphaMul = Math.min(1, age * 5);
          if (this.d1[i] <= 0) {
            this.d0[i] = 1;
            const r = uvRect('particle_drip_fall');
            this.u0[i] = r[0]; this.v0[i] = r[1]; this.du[i] = r[2]; this.dv[i] = r[3];
            this.vy[i] = -0.2;
          }
        } else if (ph === 1) {
          this.vy[i] -= grav * dt;
          const ny = this.y[i] + this.vy[i] * dt;
          if (solidAt(world, this.x[i], ny, this.z[i]) || liquidAt(world, this.x[i], ny, this.z[i])) {
            this.d0[i] = 2;
            this.d1[i] = 0.18;
            this.vy[i] = 0;
            const r = uvRect('particle_drip_land');
            this.u0[i] = r[0]; this.v0[i] = r[1]; this.du[i] = r[2]; this.dv[i] = r[3];
          } else {
            this.y[i] = ny;
          }
          if (age > life - 0.3) return false;
          sizeMul = 1;
          alphaMul = 1;
        } else {
          this.d1[i] -= dt;
          if (this.d1[i] <= 0) return false;
          sizeMul = 1.3;
          alphaMul = clamp(this.d1[i] / 0.18, 0, 1);
        }
        if (age >= life) return false;
        break;
      }
      case BH_SOUL: {
        this.x[i] += Math.sin(age * 3.4 + phase) * 0.14 * dt;
        this.z[i] += Math.cos(age * 3.0 + phase) * 0.14 * dt;
        sizeMul = 1;
        alphaMul = Math.min(1, t * 6) * (1 - t * t);
        break;
      }
      case BH_ENDROD: {
        // A lazy curl outward.
        const c = Math.cos(age * 1.2 + phase) * 0.05;
        this.vx[i] += c * dt;
        this.vz[i] += Math.sin(age * 1.1 + phase) * 0.05 * dt;
        alphaMul = Math.min(1, t * 8) * (1 - t * t);
        break;
      }
      case BH_TOTEM: {
        this.rot[i] += this.rotv[i] * dt;
        sizeMul = 1;
        alphaMul = fadeOut(t, 0.6);
        break;
      }
      case BH_DAMAGE: {
        sizeMul = 1;
        alphaMul = fadeOut(t, 0.4);
        break;
      }
      case BH_SPORE: {
        this.vx[i] += Math.sin(age * 0.9 + phase) * 0.09 * dt;
        this.vz[i] += Math.cos(age * 0.8 + phase * 1.3) * 0.09 * dt;
        alphaMul = Math.min(1, t * 12) * fadeOut(t, 0.8);
        break;
      }
      case BH_CHERRY: {
        // Petals sway hard and tumble.
        this.vx[i] += Math.sin(age * 1.6 + phase) * 0.55 * dt;
        this.vz[i] += Math.cos(age * 1.35 + phase * 1.7) * 0.55 * dt;
        this.rot[i] += this.rotv[i] * dt;
        sizeMul = 0.75 + 0.25 * Math.abs(Math.cos(this.rot[i]));
        alphaMul = Math.min(1, t * 14) * fadeOut(t, 0.88);
        break;
      }
      case BH_GLOW: {
        // Fireflies bob and pulse.
        this.x[i] += Math.sin(age * 1.3 + phase) * 0.28 * dt;
        this.y[i] += Math.sin(age * 0.9 + phase * 2.1) * 0.22 * dt;
        this.z[i] += Math.cos(age * 1.1 + phase * 1.4) * 0.28 * dt;
        const pulse = 0.35 + 0.65 * Math.max(0, Math.sin(age * 2.6 + phase * 3));
        sizeMul = 0.7 + pulse * 0.5;
        alphaMul = pulse * Math.min(1, t * 8) * fadeOut(t, 0.8);
        doIntegrate = false;
        break;
      }
      case BH_ASH: {
        this.vx[i] += Math.sin(age * 0.6 + phase) * 0.12 * dt;
        this.vz[i] += Math.cos(age * 0.5 + phase * 1.6) * 0.12 * dt;
        alphaMul = Math.min(1, t * 10) * fadeOut(t, 0.82);
        break;
      }
      case BH_FLASH: {
        sizeMul = 1;
        alphaMul = 1 - t;
        doIntegrate = false;
        break;
      }
      case BH_RISE: {
        sizeMul = 1;
        alphaMul = fadeOut(t, 0.55);
        break;
      }
      default: {
        this.rot[i] += this.rotv[i] * dt;
        break;
      }
    }

    if (doIntegrate) {
      const d = this.dragK[i];
      if (d > 0) {
        const f = Math.exp(-d * dt);
        this.vx[i] *= f; this.vy[i] *= f; this.vz[i] *= f;
      }
      if (grav !== 0) this.vy[i] -= grav * dt;

      const flags = this.flags[i];
      let nx = this.x[i] + this.vx[i] * dt;
      let ny = this.y[i] + this.vy[i] * dt;
      let nz = this.z[i] + this.vz[i] * dt;

      if ((flags & F_COLLIDE) !== 0 && world) {
        const oy = this.y[i];
        if (solidAt(world, nx, oy, this.z[i])) { nx = this.x[i]; this.vx[i] = 0; }
        if (solidAt(world, nx, oy, nz)) { nz = this.z[i]; this.vz[i] = 0; }
        if (solidAt(world, nx, ny, nz)) {
          if (this.vy[i] < 0) {
            this.flags[i] = flags | F_ON_GROUND;
            if ((flags & F_DIE_ON_GROUND) !== 0) return false;
            this.vx[i] *= 0.68; this.vz[i] *= 0.68;
          }
          ny = this.y[i];
          this.vy[i] = 0;
        } else if ((flags & F_ON_GROUND) !== 0) {
          this.flags[i] = flags & ~F_ON_GROUND;
        }
      }
      if (ny < -4 || ny > WORLD_HEIGHT + 32) return false;
      this.x[i] = nx; this.y[i] = ny; this.z[i] = nz;
      // Bubbles pop the instant they break the surface.
      if ((flags & F_WATER_ONLY) !== 0 && liquidAt(world, nx, ny, nz) !== 'water') return false;
    }

    // Refresh the cached block light now and then; particles move slowly
    // enough that once every eight frames is invisible.
    if ((this.flags[i] & F_LIT) !== 0 && ((frame + i) & 7) === 0) {
      this.lightMul[i] = lightAt(world, this.x[i], this.y[i], this.z[i]);
    }

    const lm = (this.flags[i] & F_LIT) !== 0 ? this.lightMul[i] : 1;
    this.rs[i] = (this.size0[i] + (this.size1[i] - this.size0[i]) * t) * sizeMul;
    this.ra[i] = this.alpha[i] * (alphaMul < 0 ? 0 : alphaMul > 1 ? 1 : alphaMul);
    this.rr[i] = this.cr[i] * tintR * lm;
    this.rg[i] = this.cg[i] * tintG * lm;
    this.rb[i] = this.cb[i] * tintB * lm;
    return true;
  }

  _fill() {
    const groups = this.groups;
    for (let g = 0; g < GROUP_COUNT; g++) groups[g].n = 0;
    const live = this.live;
    // Anything past the far plane of the particle world is not worth a quad.
    let cx = 0, cy = 0, cz = 0, cull = 0;
    const cam = this._camera;
    if (cam && cam.matrixWorld) {
      const e = cam.matrixWorld.elements;
      cx = e[12]; cy = e[13]; cz = e[14];
      cull = PARTICLE_CULL_DIST * PARTICLE_CULL_DIST;
    }
    for (let k = 0, n = this.liveCount; k < n; k++) {
      const i = live[k];
      const a = this.ra[i];
      if (a <= 0.002) continue;
      const s = this.rs[i];
      if (s <= 0.0005) continue;
      if (cull > 0) {
        const dx = this.x[i] - cx, dy = this.y[i] - cy, dz = this.z[i] - cz;
        if (dx * dx + dy * dy + dz * dz > cull) continue;
      }
      groups[this.group[i]].push(
        this.x[i], this.y[i], this.z[i],
        this.u0[i], this.v0[i], this.du[i], this.dv[i],
        this.rr[i], this.rg[i], this.rb[i],
        s, this.rot[i], a,
      );
    }
    for (let g = 0; g < GROUP_COUNT; g++) groups[g].commit();
  }

  /** Removes every live particle (used on world change / respawn). */
  clear() {
    for (let i = 0; i < this.max; i++) this.free[i] = this.max - 1 - i;
    this.freeCount = this.max;
    this.liveCount = 0;
    if (this.groups.length === 0) return;
    for (let g = 0; g < GROUP_COUNT; g++) { this.groups[g].n = 0; this.groups[g].commit(); }
  }

  /** Detaches the meshes and drops the event hooks. */
  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    for (let g = 0; g < GROUP_COUNT; g++) this.groups[g].dispose(this.scene);
    this.groups.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------
const fadeOut = (t, start) => (t < start ? 1 : (1 - t) / (1 - start));
const smoothstep01 = (t) => t * t * (3 - 2 * t);

/** Inverse of the linear colour conversion, for handing a colour back to spawn(). */
function hexOfLinear(r, g, b) {
  const enc = (c) => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return clamp(Math.round(v * 255), 0, 255);
  };
  return (enc(r) << 16) | (enc(g) << 8) | enc(b);
}

/** getTexture() with a guard, so a half-registered block cannot throw. */
function safeTexture(id, meta, face) {
  try {
    const n = getTexture(id, meta, face);
    if (typeof n === 'string' && n.length) return n;
  } catch { /* fall through */ }
  return 'particle_dust';
}

function atlasTexture() {
  if (Atlas && Atlas.texture) return Atlas.texture;
  try {
    const a = buildAtlas();
    if (a && a.texture) return a.texture;
  } catch (e) {
    console.warn('[particles] atlas unavailable', e && e.message);
  }
  return null;
}

/** True when the renderer expects us to encode to sRGB ourselves. */
function encodesSrgb() {
  try {
    const r = Game.renderer;
    if (r && 'outputColorSpace' in r) return r.outputColorSpace === THREE.SRGBColorSpace;
  } catch { /* not booted yet */ }
  return true;
}

function makeMaterial(kind, map, fogU, encode) {
  const defines = {};
  if (kind === G_CUTOUT) defines.CUTOUT = '';
  if (kind === G_ADD) defines.ADDITIVE = '';
  if (encode) defines.ENCODE_SRGB = '';
  return new THREE.ShaderMaterial({
    uniforms: Object.assign({ uMap: { value: map } }, fogU),
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    transparent: kind !== G_CUTOUT,
    depthWrite: kind === G_CUTOUT,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: kind === G_ADD ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------------
// Ambient particles
//
// A cheap Monte-Carlo sweep of the blocks near the player: pick random cells,
// look at what is there, and emit whatever that block or biome is supposed to
// emit. This is how vanilla does its "ambient" particles too, and it keeps the
// cost independent of the render distance.
// ---------------------------------------------------------------------------
const AMB_INTERVAL = 0.05;      // seconds between sweeps (20 Hz, like vanilla)
const AMB_RADIUS_XZ = 11;
const AMB_RADIUS_Y = 8;
const AMB_BLOCK_TRIES = 300;    // random cells probed per sweep for emitters
const AMB_DRIP_TRIES = 40;      // and for ceiling drips
let _ambAccum = 0;
let _biomeAccum = 0;
let _rainAccum = 0;
const _ambRng = new RNG(0x1f2e3d4c);

// Names of every block that breathes out particles on its own. Resolved to ids
// once, so the per-sample cost of the sweep is a single Map lookup.
const EMITTER_NAMES = [
  'torch', 'wall_torch', 'soul_torch', 'soul_wall_torch',
  'redstone_torch', 'redstone_wall_torch', 'fire', 'soul_fire',
  'campfire', 'soul_campfire', 'lava', 'magma_block',
  'nether_portal', 'end_portal', 'end_gateway', 'end_rod',
  'spore_blossom', 'crying_obsidian', 'sculk_sensor', 'sculk_shrieker',
  'pointed_dripstone', 'brewing_stand', 'mycelium',
];
let _emitters = null;
function emitterIds() {
  if (_emitters) return _emitters;
  _emitters = new Map();
  for (let i = 0; i < EMITTER_NAMES.length; i++) {
    const d = blockByName(EMITTER_NAMES[i]);
    if (d) _emitters.set(d.id, d.name);
  }
  return _emitters;
}

/**
 * Per-frame world ambience: cave drips, underwater bubbles, block emitters
 * (torches, campfires, portals, lava, ...), biome flavour (cherry petals,
 * spore blossoms, nether spores, basalt ash, swamp fireflies) and rain splash.
 * Honours the `particles` setting.
 */
export function ambientParticles(world, player, dt) {
  emitAmbient(Game.particles, world, player, dt);
}

function emitAmbient(P, world, player, dt) {
  if (!P || !world || !player || !(dt > 0)) return;
  if (_ambientQuality <= 0) return;
  _ambAccum += dt;
  if (_ambAccum < AMB_INTERVAL) return;
  const elapsed = _ambAccum;
  _ambAccum = 0;

  const rng = _ambRng;
  const px = player.x, py = player.y, pz = player.z;
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;

  // --- 1. block-driven emitters --------------------------------------------
  const bx = Math.floor(px), by = Math.floor(py), bz = Math.floor(pz);
  const emitters = emitterIds();
  const tries = Math.max(8, Math.round(AMB_BLOCK_TRIES * _ambientQuality));
  for (let n = 0; n < tries; n++) {
    const x = bx + rng.range(-AMB_RADIUS_XZ, AMB_RADIUS_XZ);
    const y = by + rng.range(-AMB_RADIUS_Y, AMB_RADIUS_Y);
    const z = bz + rng.range(-AMB_RADIUS_XZ, AMB_RADIUS_XZ);
    if (y < 0 || y >= WORLD_HEIGHT) continue;
    const id = blockAt(world, x, y, z);
    if (id === 0) continue;
    const name = emitters.get(id);
    if (name !== undefined) emitFromBlock(P, world, name, x, y, z, rng);
  }

  // --- 1b. drips out of ceilings -------------------------------------------
  const drips = Math.max(4, Math.round(AMB_DRIP_TRIES * _ambientQuality));
  for (let n = 0; n < drips; n++) {
    const x = bx + rng.range(-AMB_RADIUS_XZ, AMB_RADIUS_XZ);
    const y = by + rng.range(-AMB_RADIUS_Y, AMB_RADIUS_Y);
    const z = bz + rng.range(-AMB_RADIUS_XZ, AMB_RADIUS_XZ);
    if (y < 0 || y >= WORLD_HEIGHT - 1) continue;
    if (blockAt(world, x, y, z) !== 0) continue;
    dripUnder(P, world, x, y, z, rng);
  }

  // --- 2. underwater --------------------------------------------------------
  const eye = py + (player.eyeHeight != null ? player.eyeHeight : 1.62);
  if (liquidAt(world, px, eye, pz) === 'water') {
    const bubbles = Math.max(1, Math.round(3 * _ambientQuality));
    for (let n = 0; n < bubbles; n++) {
      P.spawn('bubble', px + rng.float(-2.5, 2.5), eye + rng.float(-1.5, 1.5), pz + rng.float(-2.5, 2.5),
        { count: 1, spread: 0 });
    }
  }

  // --- 3. biome flavour -----------------------------------------------------
  _biomeAccum += elapsed;
  if (_biomeAccum >= 0.15) {
    _biomeAccum = 0;
    biomeAmbience(P, world, player, rng);
  }

  // --- 4. rain splash on exposed surfaces ----------------------------------
  _rainAccum += elapsed;
  if (_rainAccum >= 0.1) {
    _rainAccum = 0;
    rainAmbience(P, world, player, rng);
  }
}

/** Water/lava dripping out of the ceiling above an air pocket. */
function dripUnder(P, world, x, y, z, rng) {
  const above = blockAt(world, x, y + 1, z);
  if (above === 0) return;
  const def = blockDefOf(above);
  if (def.liquid === 'water') {
    if (rng.next() < 0.45) P.spawn('drip_water', x + 0.5, y + 0.92, z + 0.5, { count: 1, spread: 0.3 });
    return;
  }
  if (def.liquid === 'lava') {
    if (rng.next() < 0.4) P.spawn('drip_lava', x + 0.5, y + 0.92, z + 0.5, { count: 1, spread: 0.3 });
    return;
  }
  if (!def.solid) return;
  // Damp cave ceilings: only underground, and rarely.
  let sky = 15;
  try { sky = world.getSkyLight(x, y, z); } catch { sky = 15; }
  if (sky > 0) return;
  if (rng.next() < 0.03) P.spawn('drip_water', x + 0.5, y + 0.92, z + 0.5, { count: 1, spread: 0.3 });
}

/** Whatever this block is supposed to breathe out. `name` is already resolved. */
function emitFromBlock(P, world, name, x, y, z, rng) {
  switch (name) {
    case 'torch':
      if (rng.next() < 0.6) {
        P.spawn('smoke', x + 0.5, y + 0.72, z + 0.5, { count: 1, spread: 0.03 });
        P.spawn('flame', x + 0.5, y + 0.7, z + 0.5, { count: 1, spread: 0.03 });
      }
      break;
    case 'wall_torch':
      if (rng.next() < 0.6) {
        P.spawn('smoke', x + 0.5, y + 0.78, z + 0.5, { count: 1, spread: 0.08 });
        P.spawn('flame', x + 0.5, y + 0.76, z + 0.5, { count: 1, spread: 0.08 });
      }
      break;
    case 'soul_torch':
    case 'soul_wall_torch':
      if (rng.next() < 0.55) P.spawn('soul', x + 0.5, y + 0.72, z + 0.5, { count: 1, spread: 0.05, size: 0.12 });
      break;
    case 'redstone_torch':
    case 'redstone_wall_torch':
      if (rng.next() < 0.3) P.spawn('dust', x + 0.5, y + 0.72, z + 0.5, { count: 1, spread: 0.06, color: 0xff2a2a });
      break;
    case 'fire':
      if (rng.next() < 0.9) {
        P.spawn('flame', x + 0.5, y + 0.35, z + 0.5, { count: 1, spread: 0.3 });
        P.spawn('smoke', x + 0.5, y + 0.5, z + 0.5, { count: 1, spread: 0.3 });
      }
      break;
    case 'soul_fire':
      if (rng.next() < 0.9) P.spawn('soul', x + 0.5, y + 0.35, z + 0.5, { count: 1, spread: 0.3 });
      break;
    case 'campfire':
      if (rng.next() < 0.7) {
        P.spawn('campfire_smoke', x + 0.5, y + 0.85, z + 0.5, { count: 1, spread: 0.12 });
        P.spawn('flame', x + 0.5, y + 0.5, z + 0.5, { count: 1, spread: 0.22 });
      }
      break;
    case 'soul_campfire':
      if (rng.next() < 0.7) {
        P.spawn('campfire_smoke', x + 0.5, y + 0.85, z + 0.5, { count: 1, spread: 0.12, color: 0x7fb8cc });
        P.spawn('soul', x + 0.5, y + 0.5, z + 0.5, { count: 1, spread: 0.22 });
      }
      break;
    case 'lava':
      if (blockAt(world, x, y + 1, z) === 0) {
        if (rng.next() < 0.06) P.spawn('lava', x + 0.5, y + 0.9, z + 0.5, { count: 1, spread: 0.3 });
        if (rng.next() < 0.09) P.spawn('smoke', x + 0.5, y + 1.05, z + 0.5, { count: 1, spread: 0.4 });
      }
      break;
    case 'magma_block':
      if (liquidAt(world, x + 0.5, y + 1.5, z + 0.5) === 'water') {
        if (rng.next() < 0.35) P.spawn('bubble', x + 0.5, y + 1.1, z + 0.5, { count: 2, spread: 0.35 });
      } else if (rng.next() < 0.08) {
        P.spawn('smoke', x + 0.5, y + 1.02, z + 0.5, { count: 1, spread: 0.35 });
      }
      break;
    case 'nether_portal':
      if (rng.next() < 0.7) P.spawn('portal', x + 0.5, y + 0.5, z + 0.5, { count: 2, spread: 0.9 });
      break;
    case 'end_portal':
    case 'end_gateway':
      if (rng.next() < 0.6) P.spawn('portal', x + 0.5, y + 0.8, z + 0.5, { count: 2, spread: 0.7 });
      break;
    case 'end_rod':
      if (rng.next() < 0.5) P.spawn('end_rod', x + 0.5, y + 0.75, z + 0.5, { count: 1, spread: 0.06 });
      break;
    case 'spore_blossom':
      if (rng.next() < 0.5) P.spawn('spore', x + 0.5, y - 0.1, z + 0.5, { count: 1, spread: 0.45 });
      break;
    case 'crying_obsidian':
      if (rng.next() < 0.12) P.spawn('drip_water', x + 0.5, y - 0.05, z + 0.5, { count: 1, spread: 0.35, color: 0x8b2fd8 });
      break;
    case 'sculk_sensor':
    case 'sculk_shrieker':
      if (rng.next() < 0.12) P.spawn('sculk', x + 0.5, y + 0.8, z + 0.5, { count: 1, spread: 0.3 });
      break;
    case 'pointed_dripstone':
      if (blockAt(world, x, y - 1, z) === 0 && rng.next() < 0.1) {
        P.spawn('drip_water', x + 0.5, y + 0.05, z + 0.5, { count: 1, spread: 0.1 });
      }
      break;
    case 'brewing_stand':
      if (rng.next() < 0.1) P.spawn('smoke', x + 0.4 + rng.next() * 0.2, y + 0.9, z + 0.4 + rng.next() * 0.2, { count: 1, spread: 0.05 });
      break;
    case 'mycelium':
      if (blockAt(world, x, y + 1, z) === 0 && rng.next() < 0.06) {
        P.spawn('mycelium', x + 0.5, y + 1.1, z + 0.5, { count: 1, spread: 0.45 });
      }
      break;
    default:
      break;
  }
}

/** Biome-specific drifting motes above and around the player. */
function biomeAmbience(P, world, player, rng) {
  let biome = null;
  try { biome = world.biomeAt(Math.floor(player.x), Math.floor(player.z)); } catch { biome = null; }
  if (!biome) return;
  const name = biome.name;
  const cat = biome.category;
  const q = _ambientQuality;

  const drop = (type, count, opts) => {
    const c = Math.max(1, Math.round(count * q));
    for (let n = 0; n < c; n++) {
      const x = player.x + rng.float(-11, 11);
      const z = player.z + rng.float(-11, 11);
      const y = player.y + rng.float(1.5, 9);
      if (blockAt(world, x, y, z) !== 0) continue;
      P.spawn(type, x, y, z, opts || { count: 1, spread: 0.3 });
    }
  };

  if (name === 'cherry_grove') {
    if (rng.next() < 0.7) drop('cherry', 2);
  } else if (name === 'lush_caves') {
    if (rng.next() < 0.4) drop('spore', 1);
  } else if (name === 'crimson_forest') {
    if (rng.next() < 0.8) drop('crimson_spore', 2);
  } else if (name === 'warped_forest') {
    if (rng.next() < 0.8) drop('warped_spore', 2);
  } else if (name === 'basalt_deltas') {
    if (rng.next() < 0.9) drop('ash', 3);
  } else if (name === 'soul_sand_valley') {
    if (rng.next() < 0.5) drop('ash', 2, { count: 1, spread: 0.3, color: 0x6f7f8f });
  } else if (name === 'deep_dark') {
    if (rng.next() < 0.15) drop('sculk', 1);
  } else if (cat === 'swamp') {
    // Fireflies: only after dark, and only just above the ground.
    let night = false;
    try { night = world.isNight(); } catch { night = false; }
    if (night && rng.next() < 0.5) {
      const c = Math.max(1, Math.round(2 * q));
      for (let n = 0; n < c; n++) {
        const x = player.x + rng.float(-10, 10);
        const z = player.z + rng.float(-10, 10);
        let top = 64;
        try { top = world.getHeight(Math.floor(x), Math.floor(z)); } catch { top = 64; }
        const y = top + 0.6 + rng.next() * 1.6;
        if (Math.abs(y - player.y) > 12) continue;
        if (blockAt(world, x, y, z) !== 0) continue;
        P.spawn('glow', x, y, z, { count: 1, spread: 0.2 });
      }
    }
  } else if (cat === 'snowy' && rng.next() < 0.25) {
    drop('snowflake', 1);
  }
}

/** Rain hitting exposed blocks around the player. */
function rainAmbience(P, world, player, rng) {
  const w = world.weather;
  if (!w || !(w.rain > 0.15)) return;
  const strength = clamp(w.rain, 0, 1);
  const count = Math.max(1, Math.round(8 * strength * _ambientQuality));
  for (let n = 0; n < count; n++) {
    const x = Math.floor(player.x) + rng.range(-9, 9);
    const z = Math.floor(player.z) + rng.range(-9, 9);
    let biome = null;
    try { biome = world.biomeAt(x, z); } catch { biome = null; }
    if (biome && biome.precipitation === 'none') continue;
    let top = -1;
    try { top = world.getHeight(x, z); } catch { top = -1; }
    if (top < 0 || top >= WORLD_HEIGHT) continue;
    if (Math.abs(top - player.y) > 14) continue;
    let sky = 0;
    try { sky = world.getSkyLight(x, top, z); } catch { sky = 0; }
    if (sky <= 0) continue;
    const snowy = biome && biome.precipitation === 'snow';
    P.spawn(snowy ? 'snowflake' : 'splash', x + rng.next(), top + 0.05, z + rng.next(),
      snowy ? { count: 1, spread: 0.2 } : { count: 1, spread: 0.05, life: 0.35 });
  }
}

export default Particles;
