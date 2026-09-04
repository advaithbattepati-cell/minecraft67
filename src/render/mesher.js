// ============================================================================
// mesher.js - Chunk voxel data -> three.js-ready vertex buffers.
//
// This is the hottest file in the project, so it is written around a few
// deliberate constraints:
//
//   * Zero allocation on the per-block path. Every buffer is a module-level
//     scratch that grows geometrically and is reused across calls.
//   * One padded neighbourhood snapshot per chunk (18 x 130 x 18) instead of
//     millions of world.getRaw() calls. Border cells are pulled from the eight
//     neighbouring chunks (falling back to world.getRaw) so chunk seams are
//     seamless: culling, smooth light and ambient occlusion all see across.
//   * Everything that involves a string (texture name resolution, atlas UV
//     lookup) is memoised by (id, meta) and never repeated.
//
// COORDINATE CONVENTION: emitted positions are in WORLD space, so a mesh built
// from this data must be added to the scene at the origin (do not also offset
// the Object3D by the chunk origin).
// ============================================================================
import {
  ID_MASK,
  WORLD_HEIGHT,
  FACE_DOWN, FACE_UP, FACE_NORTH, FACE_SOUTH, FACE_WEST, FACE_EAST,
} from '../core/constants.js';
import { AABB, hexToRgb } from '../core/util.js';
import { hash3 } from '../core/rng.js';
import { BLOCKS, BLOCK_BY_NAME, getBlock, getTexture } from '../world/blocks.js';
import { SECTION_COUNT } from '../world/chunk.js';
import { BIOMES, getBiome, biomeColorGrass, biomeColorFoliage } from '../world/biomes.js';
import { Atlas } from './atlas.js';

// ---------------------------------------------------------------------------
// Static tables derived from the block registry (built once, at import time).
// ---------------------------------------------------------------------------
const NB = Math.max(BLOCKS.length, 1);

/** 1 when the block hides neighbouring faces / occludes for ambient occlusion. */
const T_OPAQUE = new Uint8Array(NB);
/** Render pass: 0 opaque, 1 cutout, 2 translucent. */
const T_PASS = new Uint8Array(NB);
/** Model enum, see MODEL_* below. */
const T_MODEL = new Uint8Array(NB);
/** Tint kind: 0 none, 1 grass, 2 foliage, 3 water, 4 redstone, 5 birch, 6 spruce, 7 fixed hex. */
const T_TINT = new Uint8Array(NB);
/** Fixed tint colour for T_TINT === 7. */
const T_TINT_HEX = new Int32Array(NB);
/** 6-bit mask of faces the tint applies to (all faces when tintFaces is null). */
const T_TINT_FACES = new Uint8Array(NB);
/** 1 for air / cave_air / void_air. */
const T_AIR = new Uint8Array(NB);
/**
 * 1 when a block hides the shared face against another block of the same kind.
 * Vanilla does this for fluids, glass and ice but deliberately not for leaves,
 * which is what makes a leaf canopy look dense instead of hollow.
 */
const T_SELF_CULL = new Uint8Array(NB);

const MODEL_NONE = 0, MODEL_CUBE = 1, MODEL_CROSS = 2, MODEL_SLAB = 3, MODEL_STAIRS = 4,
  MODEL_FENCE = 5, MODEL_FENCE_GATE = 6, MODEL_WALL = 7, MODEL_PANE = 8, MODEL_TORCH = 9,
  MODEL_FLUID = 10, MODEL_LAYER = 11, MODEL_CARPET = 12, MODEL_FLAT = 13, MODEL_CROP = 14,
  MODEL_DOOR = 15, MODEL_TRAPDOOR = 16, MODEL_LADDER = 17, MODEL_CACTUS = 18, MODEL_CHEST = 19,
  MODEL_BED = 20, MODEL_SIGN = 21, MODEL_WALL_SIGN = 22, MODEL_BUTTON = 23, MODEL_LEVER = 24,
  MODEL_ANVIL = 25, MODEL_CAULDRON = 26, MODEL_HOPPER = 27, MODEL_END_ROD = 28,
  MODEL_LANTERN = 29, MODEL_FARMLAND = 30, MODEL_PATH = 31, MODEL_PISTON = 32,
  MODEL_PISTON_HEAD = 33, MODEL_RAIL = 34, MODEL_VINE = 35, MODEL_SKULL = 36, MODEL_POT = 37;

const MODEL_IDS = {
  none: MODEL_NONE, cube: MODEL_CUBE, column: MODEL_CUBE, cross: MODEL_CROSS,
  slab: MODEL_SLAB, stairs: MODEL_STAIRS, fence: MODEL_FENCE, fence_gate: MODEL_FENCE_GATE,
  wall: MODEL_WALL, pane: MODEL_PANE, torch: MODEL_TORCH, fluid: MODEL_FLUID,
  layer: MODEL_LAYER, carpet: MODEL_CARPET, flat: MODEL_FLAT, crop: MODEL_CROP,
  door: MODEL_DOOR, trapdoor: MODEL_TRAPDOOR, ladder: MODEL_LADDER, cactus: MODEL_CACTUS,
  chest: MODEL_CHEST, bed: MODEL_BED, sign: MODEL_SIGN, wall_sign: MODEL_WALL_SIGN,
  button: MODEL_BUTTON, lever: MODEL_LEVER, anvil: MODEL_ANVIL, cauldron: MODEL_CAULDRON,
  hopper: MODEL_HOPPER, end_rod: MODEL_END_ROD, lantern: MODEL_LANTERN,
  farmland: MODEL_FARMLAND, path: MODEL_PATH, piston: MODEL_PISTON,
  piston_head: MODEL_PISTON_HEAD, rail: MODEL_RAIL, vine: MODEL_VINE, skull: MODEL_SKULL,
  pot: MODEL_POT,
};

const TINT_IDS = { grass: 1, foliage: 2, water: 3, redstone: 4, birch: 5, spruce: 6 };
/** Non-translucent blocks that still cull against their own kind. */
const SELF_CULL_NAMES = new Set([
  'ice', 'packed_ice', 'blue_ice', 'frosted_ice', 'slime_block', 'honey_block', 'barrier',
]);
/**
 * Dense cutout families whose interior faces are never actually visible but
 * which would otherwise emit all six faces per block. A solid 16-cube of leaves
 * costs 24576 quads unculled versus 1536 culled, and a dark forest is mostly
 * leaf volume, so this is the difference between a smooth framerate and a
 * slideshow. Minecraft's "Fast" graphics setting does exactly the same thing.
 */
const SELF_CULL_SUFFIXES = ['_leaves', '_wart_block', '_mushroom_block'];
const BIRCH_TINT = 0x80a755;
const SPRUCE_TINT = 0x619961;

for (let i = 0; i < NB; i++) {
  const d = BLOCKS[i];
  if (!d) continue;
  T_OPAQUE[i] = d.opaque ? 1 : 0;
  T_PASS[i] = d.renderPass === 'translucent' ? 2 : d.renderPass === 'cutout' ? 1 : 0;
  T_MODEL[i] = MODEL_IDS[d.model] !== undefined ? MODEL_IDS[d.model] : MODEL_CUBE;
  T_AIR[i] = d.air ? 1 : 0;
  if (typeof d.tint === 'number') { T_TINT[i] = 7; T_TINT_HEX[i] = d.tint; }
  else if (d.tint && TINT_IDS[d.tint]) T_TINT[i] = TINT_IDS[d.tint];
  if (d.tintFaces) {
    let m = 0;
    for (let k = 0; k < d.tintFaces.length; k++) m |= 1 << (d.tintFaces[k] & 7);
    T_TINT_FACES[i] = m;
  } else {
    T_TINT_FACES[i] = 0x3f;
  }
  T_SELF_CULL[i] = (T_PASS[i] === 2 || d.name.indexOf('glass') >= 0
    || SELF_CULL_NAMES.has(d.name)
    || SELF_CULL_SUFFIXES.some((sfx) => d.name.endsWith(sfx))) ? 1 : 0;
}

/** Pre-resolved rgb for the constant tints, so the hot path never allocates. */
const T_FIXED_RGB = new Float32Array(NB * 3);
for (let i = 0; i < NB; i++) {
  const k = T_TINT[i];
  if (k !== 5 && k !== 6 && k !== 7) continue;
  const hex = k === 5 ? BIRCH_TINT : k === 6 ? SPRUCE_TINT : T_TINT_HEX[i];
  const c = hexToRgb(hex);
  T_FIXED_RGB[i * 3] = c[0]; T_FIXED_RGB[i * 3 + 1] = c[1]; T_FIXED_RGB[i * 3 + 2] = c[2];
}

const AIR_ID = 0;
const BEDROCK_ID = (BLOCK_BY_NAME.get('bedrock') || { id: 1 }).id;
const nameId = (n) => { const d = BLOCK_BY_NAME.get(n); return d ? d.id : -1; };

const ID_NETHER_PORTAL = nameId('nether_portal');
const ID_COCOA = nameId('cocoa');
const ID_SOUL_SAND = nameId('soul_sand');
const SOUL_SAND_BOX = [[0, 0, 0, 1, 14 / 16, 1]];
const ID_GLASS_PANE_LIKE = new Set();
for (const n of BLOCK_BY_NAME.keys()) {
  const d = BLOCK_BY_NAME.get(n);
  if (d && d.model === 'pane') ID_GLASS_PANE_LIKE.add(d.id);
}
const T_FENCEY = new Uint8Array(NB);   // connects to fences / walls / gates
for (let i = 0; i < NB; i++) {
  const d = BLOCKS[i];
  if (!d) continue;
  if (d.model === 'fence' || d.model === 'wall' || d.model === 'fence_gate') T_FENCEY[i] = 1;
}

// Shapes that the block registry cannot express through `model` alone. Keyed by
// block id; each entry is a list of [x0,y0,z0,x1,y1,z1] boxes in 0..1 space.
const S = 1 / 16;
const CUSTOM_SHAPE = new Array(NB).fill(null);
const CUSTOM_SHAPE_SRC = {
  cake: [[S, 0, S, 15 * S, 0.5, 15 * S]],
  dragon_egg: [[S, 0, S, 15 * S, 1, 15 * S]],
  enchanting_table: [[0, 0, 0, 1, 0.75, 1]],
  stonecutter: [[0, 0, 0, 1, 9 * S, 1]],
  end_portal_frame: [[0, 0, 0, 1, 13 * S, 1]],
  conduit: [[5 * S, 5 * S, 5 * S, 11 * S, 11 * S, 11 * S]],
  grindstone: [[2 * S, 4 * S, 6 * S, 14 * S, 1, 10 * S], [4 * S, 0, 6 * S, 6 * S, 4 * S, 10 * S], [10 * S, 0, 6 * S, 12 * S, 4 * S, 10 * S]],
  lectern: [[0, 0, 0, 1, 2 * S, 1], [4 * S, 2 * S, 4 * S, 12 * S, 1, 12 * S]],
  chorus_plant: [[3 * S, 0, 3 * S, 13 * S, 1, 13 * S]],
  chorus_flower: [[2 * S, 2 * S, 2 * S, 14 * S, 14 * S, 14 * S]],
  sniffer_egg: [[S, 0, S, 15 * S, 1, 15 * S]],
  scaffolding: [
    [0, 14 * S, 0, 1, 1, 1],
    [0, 0, 0, 2 * S, 14 * S, 2 * S], [14 * S, 0, 0, 1, 14 * S, 2 * S],
    [0, 0, 14 * S, 2 * S, 14 * S, 1], [14 * S, 0, 14 * S, 1, 14 * S, 1],
  ],
  turtle_egg: [[5 * S, 0, 5 * S, 11 * S, 7 * S, 11 * S]],
  brewing_stand: [[7 * S, 0, 7 * S, 9 * S, 14 * S, 9 * S], [2 * S, 0, 2 * S, 14 * S, 2 * S, 14 * S]],
  decorated_pot: [[S, 0, S, 15 * S, 1, 15 * S]],
  bell: [[5 * S, 4 * S, 5 * S, 11 * S, 1, 11 * S]],
  sculk_sensor: [
    [0, 0, 0, 1, 8 * S, 1],
    [3 * S, 8 * S, 3 * S, 5 * S, 14 * S, 5 * S], [11 * S, 8 * S, 11 * S, 13 * S, 14 * S, 13 * S],
  ],
  calibrated_sculk_sensor: [
    [0, 0, 0, 1, 8 * S, 1],
    [3 * S, 8 * S, 3 * S, 5 * S, 14 * S, 5 * S], [11 * S, 8 * S, 11 * S, 13 * S, 14 * S, 13 * S],
  ],
  sculk_shrieker: [[0, 0, 0, 1, 8 * S, 1]],
  big_dripleaf: [[0, 11 * S, 0, 1, 15 * S, 1]],
  lily_pad: [[S, 0, S, 15 * S, S, 15 * S]],
  end_portal: [[0, 0, 0, 1, 12 * S, 1]],
  campfire: [[0, 0, 0, 1, 7 * S, 1]],
  soul_campfire: [[0, 0, 0, 1, 7 * S, 1]],
};
for (const k in CUSTOM_SHAPE_SRC) {
  const d = BLOCK_BY_NAME.get(k);
  if (d && CUSTOM_SHAPE_SRC[k]) CUSTOM_SHAPE[d.id] = CUSTOM_SHAPE_SRC[k];
}

// ---------------------------------------------------------------------------
// Face tables
// ---------------------------------------------------------------------------
const FACE_NX = [0, 0, 0, 0, -1, 1];
const FACE_NY = [-1, 1, 0, 0, 0, 0];
const FACE_NZ = [0, 0, -1, 1, 0, 0];
/** Directional shading baked into the vertex colour. */
const FACE_SHADE = [0.5, 1.0, 0.8, 0.8, 0.6, 0.6];

// Padded neighbourhood strides.
const PW = 18, PH = WORLD_HEIGHT + 2;
const PSX = 1, PSZ = PW, PSY = PW * PW;      // 1 / 18 / 324
const P_SIZE = PW * PW * PH;
const pIdx = (px, py, pz) => py * PSY + pz * PSZ + px;

/** Stride along the face's first tangent axis, per face. */
const FACE_TU_STRIDE = [PSX, PSX, PSX, PSX, PSZ, PSZ];
/** Stride along the face's second tangent axis, per face. */
const FACE_TV_STRIDE = [PSZ, PSZ, PSY, PSY, PSY, PSY];
/** Corner sign along tangent u, per face, in emission order. */
const CORNER_U = [
  [-1, 1, 1, -1], [-1, 1, 1, -1], [1, -1, -1, 1], [-1, 1, 1, -1], [-1, 1, 1, -1], [1, -1, -1, 1],
];
/** Corner sign along tangent v, per face, in emission order. */
const CORNER_V = [
  [-1, -1, 1, 1], [1, 1, -1, -1], [-1, -1, 1, 1], [-1, -1, 1, 1], [-1, -1, 1, 1], [-1, -1, 1, 1],
];

/** Standard 0/1/2/3 ambient-occlusion darkening table. */
const AO_TABLE = [0.42, 0.62, 0.82, 1.0];

// Gamma curve: level (0..15) -> brightness, sampled at 1/16 of a level.
const LIGHT_LUT = new Float32Array(241);
for (let i = 0; i <= 240; i++) {
  const lv = i / 16;
  LIGHT_LUT[i] = 0.05 + 0.95 * Math.pow(lv / 15, 1.4);
}
const curve = (lv) => LIGHT_LUT[lv <= 0 ? 0 : lv >= 15 ? 240 : (lv * 16) | 0];

const EPS = 1e-4;

// ---------------------------------------------------------------------------
// Growable geometry builders (three, one per render pass)
// ---------------------------------------------------------------------------
function makeBuilder(verts) {
  return {
    pos: new Float32Array(verts * 3),
    nrm: new Float32Array(verts * 3),
    uv: new Float32Array(verts * 2),
    col: new Float32Array(verts * 3),
    idx: new Uint32Array((verts >> 1) * 3),
    v: 0,
    i: 0,
  };
}

function growF32(arr, need) {
  let n = arr.length || 1;
  while (n < need) n *= 2;
  const out = new Float32Array(n);
  out.set(arr);
  return out;
}
function growU32(arr, need) {
  let n = arr.length || 1;
  while (n < need) n *= 2;
  const out = new Uint32Array(n);
  out.set(arr);
  return out;
}

/** Makes room for `nv` more vertices and `ni` more indices. */
function reserve(b, nv, ni) {
  const v3 = (b.v + nv) * 3;
  if (v3 > b.pos.length) {
    b.pos = growF32(b.pos, v3);
    b.nrm = growF32(b.nrm, v3);
    b.col = growF32(b.col, v3);
    b.uv = growF32(b.uv, (b.v + nv) * 2);
  } else if ((b.v + nv) * 2 > b.uv.length) {
    b.uv = growF32(b.uv, (b.v + nv) * 2);
  }
  if (b.i + ni > b.idx.length) b.idx = growU32(b.idx, b.i + ni);
}

const B_OPAQUE = makeBuilder(8192);
const B_CUTOUT = makeBuilder(4096);
const B_TRANS = makeBuilder(2048);
const BUILDERS = [B_OPAQUE, B_CUTOUT, B_TRANS];

function resetBuilders() {
  B_OPAQUE.v = 0; B_OPAQUE.i = 0;
  B_CUTOUT.v = 0; B_CUTOUT.i = 0;
  B_TRANS.v = 0; B_TRANS.i = 0;
}

function finish(b) {
  if (b.v === 0 || b.i === 0) return null;
  return {
    position: b.pos.slice(0, b.v * 3),
    normal: b.nrm.slice(0, b.v * 3),
    uv: b.uv.slice(0, b.v * 2),
    color: b.col.slice(0, b.v * 3),
    index: b.idx.slice(0, b.i),
  };
}

// ---------------------------------------------------------------------------
// Padded neighbourhood snapshot
// ---------------------------------------------------------------------------
const pBlocks = new Uint16Array(P_SIZE);
const pLight = new Uint8Array(P_SIZE);
const pOcc = new Uint8Array(P_SIZE);
const pBiome = new Uint8Array(PW * PW);
let dayFactor = 1;

const _neigh = new Array(9).fill(null);

/**
 * Copies the chunk plus a one-block skirt of its neighbours into the padded
 * scratch arrays. Everything downstream reads only from these.
 */
function loadNeighborhood(world, chunk) {
  const cx = chunk.cx, cz = chunk.cz;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      _neigh[(dz + 1) * 3 + (dx + 1)] = (dx === 0 && dz === 0)
        ? chunk
        : (world.getChunk ? world.getChunk(cx + dx, cz + dz) || null : null);
    }
  }

  const blocks = chunk.blocks, light = chunk.light;
  const counts = chunk.sectionCounts;

  // --- interior ----------------------------------------------------------
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const empty = counts ? counts[y >> 4] === 0 : false;
    const py = y + 1;
    for (let z = 0; z < 16; z++) {
      const src = (y << 8) | (z << 4);
      const dst = py * PSY + (z + 1) * PSZ + 1;
      if (empty) {
        pBlocks.fill(0, dst, dst + 16);
        pOcc.fill(0, dst, dst + 16);
        for (let x = 0; x < 16; x++) pLight[dst + x] = light[src + x];
      } else {
        for (let x = 0; x < 16; x++) {
          const v = blocks[src + x];
          pBlocks[dst + x] = v;
          pOcc[dst + x] = T_OPAQUE[v & ID_MASK];
          pLight[dst + x] = light[src + x];
        }
      }
    }
  }

  // --- y = -1 (bedrock floor) and y = WORLD_HEIGHT (open sky) ------------
  const bottom = BEDROCK_ID;
  for (let i = 0; i < PSY; i++) {
    pBlocks[i] = bottom; pOcc[i] = 1; pLight[i] = 0;
  }
  const topBase = (WORLD_HEIGHT + 1) * PSY;
  for (let i = 0; i < PSY; i++) {
    pBlocks[topBase + i] = 0; pOcc[topBase + i] = 0; pLight[topBase + i] = 0xf0;
  }

  // --- the four side skirts (plus corners) --------------------------------
  const ox = cx << 4, oz = cz << 4;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const py = y + 1;
    for (let pz = 0; pz < PW; pz++) {
      const edgeZ = pz === 0 || pz === PW - 1;
      const xs = edgeZ ? 1 : PW - 1;   // full row on the z edges, endpoints otherwise
      for (let px = 0; px < PW; px += xs) {
        const i = py * PSY + pz * PSZ + px;
        const wx = ox + px - 1, wz = oz + pz - 1;
        const dx = px === 0 ? -1 : px === PW - 1 ? 1 : 0;
        const dz = pz === 0 ? -1 : pz === PW - 1 ? 1 : 0;
        const c = _neigh[(dz + 1) * 3 + (dx + 1)];
        if (c) {
          const li = (y << 8) | ((wz & 15) << 4) | (wx & 15);
          const v = c.blocks[li];
          pBlocks[i] = v;
          pOcc[i] = T_OPAQUE[v & ID_MASK];
          pLight[i] = c.light[li];
        } else {
          const v = world.getRaw ? world.getRaw(wx, y, wz) : 0;
          pBlocks[i] = v;
          pOcc[i] = T_OPAQUE[v & ID_MASK];
          pLight[i] = 0xf0;
        }
      }
    }
  }

  // --- biome columns -------------------------------------------------------
  for (let pz = 0; pz < PW; pz++) {
    for (let px = 0; px < PW; px++) {
      const dx = px === 0 ? -1 : px === PW - 1 ? 1 : 0;
      const dz = pz === 0 ? -1 : pz === PW - 1 ? 1 : 0;
      const c = _neigh[(dz + 1) * 3 + (dx + 1)];
      const wx = ox + px - 1, wz = oz + pz - 1;
      pBiome[pz * PW + px] = c
        ? c.biomes[((wz & 15) << 4) | (wx & 15)]
        : (world.getBiome ? world.getBiome(wx, wz) : 0);
    }
  }

  dayFactor = world.skyLightFactor ? world.skyLightFactor() : 1;
  if (!(dayFactor >= 0)) dayFactor = 1;
}

/** Combined render light level (0..15) at a padded cell. */
function lightAt(i) {
  const l = pLight[i];
  const sky = (l >> 4) * dayFactor;
  const blk = l & 15;
  return sky > blk ? sky : blk;
}

// ---------------------------------------------------------------------------
// Per-face smooth light + ambient occlusion
// ---------------------------------------------------------------------------
const _lv = new Float32Array(4);
const _ao = new Float32Array(4);

/**
 * Fills `_lv` (brightness per corner) and `_ao` (occlusion per corner) for one
 * face. `tu0/tu1/tv0/tv1` are the face's extents along its two tangent axes in
 * 0..1 block space: a corner only samples the neighbouring column when the
 * quad actually reaches the block edge there, which keeps slabs and stairs
 * from picking up occlusion from blocks their geometry never touches.
 */
function sampleFace(f, ai, tu0, tu1, tv0, tv1, smooth) {
  if (!smooth) {
    const l = curve(lightAt(ai));
    _lv[0] = _lv[1] = _lv[2] = _lv[3] = l;
    _ao[0] = _ao[1] = _ao[2] = _ao[3] = 1;
    return;
  }
  const su = FACE_TU_STRIDE[f], sv = FACE_TV_STRIDE[f];
  const cu = CORNER_U[f], cv = CORNER_V[f];
  const uLow = tu0 <= EPS, uHigh = tu1 >= 1 - EPS;
  const vLow = tv0 <= EPS, vHigh = tv1 >= 1 - EPS;
  const selfOcc = pOcc[ai];
  const selfL = lightAt(ai);
  for (let k = 0; k < 4; k++) {
    const su1 = cu[k] < 0 ? (uLow ? -su : 0) : (uHigh ? su : 0);
    const sv1 = cv[k] < 0 ? (vLow ? -sv : 0) : (vHigh ? sv : 0);
    const i1 = ai + su1, i2 = ai + sv1, i3 = ai + su1 + sv1;
    const o1 = su1 ? pOcc[i1] : 0;
    const o2 = sv1 ? pOcc[i2] : 0;
    const o3 = (su1 || sv1) ? pOcc[i3] : 0;
    const level = (o1 && o2) ? 0 : 3 - (o1 + o2 + o3);
    _ao[k] = AO_TABLE[level];

    let sum = 0, n = 0;
    if (!selfOcc) { sum += selfL; n++; }
    if (su1 && !o1) { sum += lightAt(i1); n++; }
    if (sv1 && !o2) { sum += lightAt(i2); n++; }
    if ((su1 || sv1) && !o3 && !(o1 && o2)) { sum += lightAt(i3); n++; }
    _lv[k] = curve(n ? sum / n : selfL);
  }
}

// ---------------------------------------------------------------------------
// Quad emission
// ---------------------------------------------------------------------------
const _qp = new Float32Array(12);
const _qu = new Float32Array(8);
const _qc = new Float32Array(12);

// Current block origin in world space + optional shear (used by torches/levers).
let _ox = 0, _oy = 0, _oz = 0;
let _shOn = false, _shX = 0, _shZ = 0, _shPivot = 0;

function setP(k, x, y, z) {
  if (_shOn) { const d = y - _shPivot; x += _shX * d; z += _shZ * d; }
  const o = k * 3;
  _qp[o] = _ox + x; _qp[o + 1] = _oy + y; _qp[o + 2] = _oz + z;
}
function setUV(k, u, v) { _qu[k * 2] = u; _qu[k * 2 + 1] = v; }
function setC(k, r, g, b) { const o = k * 3; _qc[o] = r; _qc[o + 1] = g; _qc[o + 2] = b; }
function setCAll(r, g, b) {
  for (let k = 0; k < 4; k++) { const o = k * 3; _qc[o] = r; _qc[o + 1] = g; _qc[o + 2] = b; }
}

/** Pushes the scratch quad. `flip` swaps the triangulation diagonal. */
function emitQuad(b, nx, ny, nz, flip) {
  reserve(b, 4, 6);
  const vi = b.v;
  const P = b.pos, N = b.nrm, U = b.uv, C = b.col, I = b.idx;
  let p = vi * 3, t = vi * 2;
  for (let k = 0; k < 4; k++) {
    const o = k * 3, o2 = k * 2;
    P[p] = _qp[o]; P[p + 1] = _qp[o + 1]; P[p + 2] = _qp[o + 2];
    N[p] = nx; N[p + 1] = ny; N[p + 2] = nz;
    C[p] = _qc[o]; C[p + 1] = _qc[o + 1]; C[p + 2] = _qc[o + 2];
    U[t] = _qu[o2]; U[t + 1] = _qu[o2 + 1];
    p += 3; t += 2;
  }
  let i = b.i;
  if (flip) {
    I[i] = vi + 1; I[i + 1] = vi + 2; I[i + 2] = vi + 3;
    I[i + 3] = vi + 1; I[i + 4] = vi + 3; I[i + 5] = vi;
  } else {
    I[i] = vi; I[i + 1] = vi + 1; I[i + 2] = vi + 2;
    I[i + 3] = vi; I[i + 4] = vi + 2; I[i + 5] = vi + 3;
  }
  b.v = vi + 4; b.i = i + 6;
}

/** Same quad wound the other way, for double-sided plants / panes / vines. */
function emitQuadBack(b, nx, ny, nz) {
  reserve(b, 4, 6);
  const vi = b.v;
  const P = b.pos, N = b.nrm, U = b.uv, C = b.col, I = b.idx;
  let p = vi * 3, t = vi * 2;
  for (let k = 3; k >= 0; k--) {
    const o = k * 3, o2 = k * 2;
    P[p] = _qp[o]; P[p + 1] = _qp[o + 1]; P[p + 2] = _qp[o + 2];
    N[p] = nx; N[p + 1] = ny; N[p + 2] = nz;
    C[p] = _qc[o]; C[p + 1] = _qc[o + 1]; C[p + 2] = _qc[o + 2];
    U[t] = _qu[o2]; U[t + 1] = _qu[o2 + 1];
    p += 3; t += 2;
  }
  const i = b.i;
  I[i] = vi; I[i + 1] = vi + 1; I[i + 2] = vi + 2;
  I[i + 3] = vi; I[i + 4] = vi + 2; I[i + 5] = vi + 3;
  b.v = vi + 4; b.i = i + 6;
}

// ---------------------------------------------------------------------------
// Texture / UV memoisation
// ---------------------------------------------------------------------------
let _uvCache = new Array(65536);
let _nameUV = new Map();

/** Cached six-face UV rects for one (id, meta) pair. */
function faceUVs(id, meta) {
  const key = (id << 4) | (meta & 15);
  let a = _uvCache[key];
  if (a) return a;
  a = new Array(6);
  for (let f = 0; f < 6; f++) {
    let n;
    try { n = getTexture(id, meta, f); } catch { n = 'missing'; }
    a[f] = Atlas.uv(n);
  }
  _uvCache[key] = a;
  return a;
}

/** Cached UV rect for one texture name. */
function uvOf(name) {
  let u = _nameUV.get(name);
  if (u) return u;
  u = Atlas.uv(name);
  _nameUV.set(name, u);
  return u;
}

// Scratch: the six UV rects used by the current box.
const _fuv = new Array(6);
function fillUVFromBlock(id, meta) {
  const a = faceUVs(id, meta);
  for (let f = 0; f < 6; f++) _fuv[f] = a[f];
}

// ---------------------------------------------------------------------------
// Biome tinting
// ---------------------------------------------------------------------------
const NBIOME = Math.max(BIOMES.length, 1);
let _grassCache = new Float32Array(NBIOME * WORLD_HEIGHT * 3);
let _grassValid = new Uint8Array(NBIOME * WORLD_HEIGHT);
let _foliageCache = new Float32Array(NBIOME * WORLD_HEIGHT * 3);
let _foliageValid = new Uint8Array(NBIOME * WORLD_HEIGHT);
let _waterCache = new Float32Array(NBIOME * 3);
let _waterValid = new Uint8Array(NBIOME);

function grassRGB(bid, y, out, w) {
  if (bid >= NBIOME) bid = 0;
  const k = bid * WORLD_HEIGHT + y;
  if (!_grassValid[k]) {
    const hex = biomeColorGrass(getBiome(bid), y);
    const c = hexToRgb(hex);
    _grassCache[k * 3] = c[0]; _grassCache[k * 3 + 1] = c[1]; _grassCache[k * 3 + 2] = c[2];
    _grassValid[k] = 1;
  }
  out[0] += _grassCache[k * 3] * w;
  out[1] += _grassCache[k * 3 + 1] * w;
  out[2] += _grassCache[k * 3 + 2] * w;
}

function foliageRGB(bid, y, out, w) {
  if (bid >= NBIOME) bid = 0;
  const k = bid * WORLD_HEIGHT + y;
  if (!_foliageValid[k]) {
    const hex = biomeColorFoliage(getBiome(bid), y);
    const c = hexToRgb(hex);
    _foliageCache[k * 3] = c[0]; _foliageCache[k * 3 + 1] = c[1]; _foliageCache[k * 3 + 2] = c[2];
    _foliageValid[k] = 1;
  }
  out[0] += _foliageCache[k * 3] * w;
  out[1] += _foliageCache[k * 3 + 1] * w;
  out[2] += _foliageCache[k * 3 + 2] * w;
}

function waterRGB(bid, out) {
  if (bid >= NBIOME) bid = 0;
  if (!_waterValid[bid]) {
    const c = hexToRgb(getBiome(bid).waterColor);
    _waterCache[bid * 3] = c[0]; _waterCache[bid * 3 + 1] = c[1]; _waterCache[bid * 3 + 2] = c[2];
    _waterValid[bid] = 1;
  }
  out[0] = _waterCache[bid * 3]; out[1] = _waterCache[bid * 3 + 1]; out[2] = _waterCache[bid * 3 + 2];
}

const _tint = new Float32Array(3);

/**
 * Resolves the multiplicative tint for a block. Grass and foliage average the
 * four diagonal columns around the block so biome borders fade smoothly.
 */
function computeTint(id, meta, px, py, pz, y) {
  const kind = T_TINT[id];
  if (kind === 0) { _tint[0] = _tint[1] = _tint[2] = 1; return 0; }
  const yc = y < 0 ? 0 : y >= WORLD_HEIGHT ? WORLD_HEIGHT - 1 : y;
  if (kind === 1 || kind === 2) {
    _tint[0] = 0; _tint[1] = 0; _tint[2] = 0;
    const fn = kind === 1 ? grassRGB : foliageRGB;
    const w = 0.25;
    fn(pBiome[(pz - 1) * PW + (px - 1)], yc, _tint, w);
    fn(pBiome[(pz - 1) * PW + (px + 1)], yc, _tint, w);
    fn(pBiome[(pz + 1) * PW + (px - 1)], yc, _tint, w);
    fn(pBiome[(pz + 1) * PW + (px + 1)], yc, _tint, w);
    return kind;
  }
  if (kind === 3) { waterRGB(pBiome[pz * PW + px], _tint); return kind; }
  if (kind === 4) {
    const f = (meta & 15) / 15;
    _tint[0] = 0.32 + 0.68 * f;
    _tint[1] = 0.03 + 0.22 * f * f;
    _tint[2] = 0.03;
    return kind;
  }
  _tint[0] = T_FIXED_RGB[id * 3];
  _tint[1] = T_FIXED_RGB[id * 3 + 1];
  _tint[2] = T_FIXED_RGB[id * 3 + 2];
  return kind;
}

// ---------------------------------------------------------------------------
// The box emitter
// ---------------------------------------------------------------------------
let _tr = 1, _tg = 1, _tb = 1, _tintMask = 0;

/**
 * Emits the requested faces of an axis-aligned box in 0..1 block space.
 * UVs are derived from the box extents so a half-height slab shows the bottom
 * half of its texture, exactly like vanilla.
 */
function emitBox(b, pi, x0, y0, z0, x1, y1, z1, mask, smooth) {
  for (let f = 0; f < 6; f++) {
    if (!(mask & (1 << f))) continue;
    const uv = _fuv[f];
    if (!uv) continue;
    const u0 = uv.u0, v0 = uv.v0, u1 = uv.u1, v1 = uv.v1;
    const du = u1 - u0, dv = v1 - v0;

    // Anchor cell for lighting: the neighbouring cell when the quad sits on
    // the block boundary, otherwise the block's own cell.
    let ai = pi, boundary = false;
    switch (f) {
      case FACE_DOWN: if (y0 <= EPS) { ai = pi - PSY; boundary = true; } break;
      case FACE_UP: if (y1 >= 1 - EPS) { ai = pi + PSY; boundary = true; } break;
      case FACE_NORTH: if (z0 <= EPS) { ai = pi - PSZ; boundary = true; } break;
      case FACE_SOUTH: if (z1 >= 1 - EPS) { ai = pi + PSZ; boundary = true; } break;
      case FACE_WEST: if (x0 <= EPS) { ai = pi - PSX; boundary = true; } break;
      default: if (x1 >= 1 - EPS) { ai = pi + PSX; boundary = true; } break;
    }
    if (f <= 1) sampleFace(f, ai, x0, x1, z0, z1, smooth && boundary);
    else if (f <= 3) sampleFace(f, ai, x0, x1, y0, y1, smooth && boundary);
    else sampleFace(f, ai, z0, z1, y0, y1, smooth && boundary);

    const shade = FACE_SHADE[f];
    const tinted = (_tintMask & (1 << f)) !== 0;
    const tr = tinted ? _tr : 1, tg = tinted ? _tg : 1, tb = tinted ? _tb : 1;
    for (let k = 0; k < 4; k++) {
      const l = _lv[k] * _ao[k] * shade;
      setC(k, l * tr, l * tg, l * tb);
    }

    switch (f) {
      case FACE_UP:
        setP(0, x0, y1, z1); setP(1, x1, y1, z1); setP(2, x1, y1, z0); setP(3, x0, y1, z0);
        setUV(0, u0 + du * x0, v0 + dv * z1); setUV(1, u0 + du * x1, v0 + dv * z1);
        setUV(2, u0 + du * x1, v0 + dv * z0); setUV(3, u0 + du * x0, v0 + dv * z0);
        break;
      case FACE_DOWN:
        setP(0, x0, y0, z0); setP(1, x1, y0, z0); setP(2, x1, y0, z1); setP(3, x0, y0, z1);
        setUV(0, u0 + du * x0, v0 + dv * z0); setUV(1, u0 + du * x1, v0 + dv * z0);
        setUV(2, u0 + du * x1, v0 + dv * z1); setUV(3, u0 + du * x0, v0 + dv * z1);
        break;
      case FACE_NORTH:
        setP(0, x1, y0, z0); setP(1, x0, y0, z0); setP(2, x0, y1, z0); setP(3, x1, y1, z0);
        setUV(0, u1 - du * x1, v1 - dv * y0); setUV(1, u1 - du * x0, v1 - dv * y0);
        setUV(2, u1 - du * x0, v1 - dv * y1); setUV(3, u1 - du * x1, v1 - dv * y1);
        break;
      case FACE_SOUTH:
        setP(0, x0, y0, z1); setP(1, x1, y0, z1); setP(2, x1, y1, z1); setP(3, x0, y1, z1);
        setUV(0, u0 + du * x0, v1 - dv * y0); setUV(1, u0 + du * x1, v1 - dv * y0);
        setUV(2, u0 + du * x1, v1 - dv * y1); setUV(3, u0 + du * x0, v1 - dv * y1);
        break;
      case FACE_WEST:
        setP(0, x0, y0, z0); setP(1, x0, y0, z1); setP(2, x0, y1, z1); setP(3, x0, y1, z0);
        setUV(0, u0 + du * z0, v1 - dv * y0); setUV(1, u0 + du * z1, v1 - dv * y0);
        setUV(2, u0 + du * z1, v1 - dv * y1); setUV(3, u0 + du * z0, v1 - dv * y1);
        break;
      default:
        setP(0, x1, y0, z1); setP(1, x1, y0, z0); setP(2, x1, y1, z0); setP(3, x1, y1, z1);
        setUV(0, u1 - du * z1, v1 - dv * y0); setUV(1, u1 - du * z0, v1 - dv * y0);
        setUV(2, u1 - du * z0, v1 - dv * y1); setUV(3, u1 - du * z1, v1 - dv * y1);
        break;
    }
    // Flip the split when the 0-2 diagonal is the darker pair. Leaving the
    // dark corner on the shared edge smears its occlusion right across the
    // quad, which is the classic AO "diagonal seam" artefact.
    const flip = (_ao[0] * _lv[0] + _ao[2] * _lv[2]) < (_ao[1] * _lv[1] + _ao[3] * _lv[3]) - 1e-6;
    emitQuad(b, FACE_NX[f], FACE_NY[f], FACE_NZ[f], flip);
  }
}

// The block currently being emitted; sub-boxes use it to cull against
// neighbours without every helper having to thread the id through.
let _curId = 0;

/** Emits a sub-box, culling only the faces that sit on the block boundary. */
function boxAll(b, pi, x0, y0, z0, x1, y1, z1, smooth) {
  emitBox(b, pi, x0, y0, z0, x1, y1, z1,
    cullMask(_curId, pi, x0, y0, z0, x1, y1, z1), smooth);
}

// ---------------------------------------------------------------------------
// Face visibility
// ---------------------------------------------------------------------------
/** True when the neighbour does not fully hide this face. */
function visible(selfId, nv) {
  const nid = nv & ID_MASK;
  if (nid === AIR_ID) return true;
  if (T_OPAQUE[nid]) return false;
  if (nid === selfId && T_SELF_CULL[selfId]) return false;
  return true;
}

/** Builds the 6-bit visible-face mask for a box, culling only boundary faces. */
function cullMask(id, pi, x0, y0, z0, x1, y1, z1) {
  let m = 0;
  if (y0 > EPS || visible(id, pBlocks[pi - PSY])) m |= 1 << FACE_DOWN;
  if (y1 < 1 - EPS || visible(id, pBlocks[pi + PSY])) m |= 1 << FACE_UP;
  if (z0 > EPS || visible(id, pBlocks[pi - PSZ])) m |= 1 << FACE_NORTH;
  if (z1 < 1 - EPS || visible(id, pBlocks[pi + PSZ])) m |= 1 << FACE_SOUTH;
  if (x0 > EPS || visible(id, pBlocks[pi - PSX])) m |= 1 << FACE_WEST;
  if (x1 < 1 - EPS || visible(id, pBlocks[pi + PSX])) m |= 1 << FACE_EAST;
  return m;
}

// ---------------------------------------------------------------------------
// Free-form quads (plants, rails, vines, fluids)
// ---------------------------------------------------------------------------
/**
 * Emits one arbitrary quad with flat lighting taken from `pi`, given four
 * corners in block space and the uv rect to stretch across it.
 */
function freeQuad(b, pi, uv, shade,
  ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, both) {
  if (!uv) return;
  const l = curve(lightAt(pi)) * shade;
  setCAll(l * _tr, l * _tg, l * _tb);
  setP(0, ax, ay, az); setP(1, bx, by, bz); setP(2, cx, cy, cz); setP(3, dx, dy, dz);
  setUV(0, uv.u0, uv.v1); setUV(1, uv.u1, uv.v1); setUV(2, uv.u1, uv.v0); setUV(3, uv.u0, uv.v0);
  // Newell normal of the first triangle is enough for these flat quads.
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - bx, e2y = cy - by, e2z = cz - bz;
  let nx = e1y * e2z - e1z * e2y;
  let ny = e1z * e2x - e1x * e2z;
  let nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  emitQuad(b, nx, ny, nz, false);
  // `both` is vestigial: every emitter that passes it lands in the cutout
  // builder, whose material is double-sided, so a reversed copy was an exact
  // coplanar duplicate. A poppy cost 8 triangles where 4 suffice.
  void both;
}

// ---------------------------------------------------------------------------
// Model emitters
// ---------------------------------------------------------------------------
const HDX = [0, 1, 0, -1];   // horizontal facing 0=N(-Z) 1=E(+X) 2=S(+Z) 3=W(-X)
const HDZ = [-1, 0, 1, 0];

/** Cross-shaped plant: two diagonal quads, jittered by a hash of the column. */
function emitCross(b, id, meta, pi, wx, wy, wz) {
  const uv = faceUVs(id, meta)[FACE_NORTH];
  const h = hash3(0x51ed270b, wx, 0, wz);
  const ox = ((h & 15) / 15 - 0.5) * 0.375;
  const oz = (((h >> 8) & 15) / 15 - 0.5) * 0.375;
  const a = 0.5 - 0.5 * Math.SQRT1_2 * 1.05 + ox;
  const c = 0.5 + 0.5 * Math.SQRT1_2 * 1.05 + ox;
  const a2 = 0.5 - 0.5 * Math.SQRT1_2 * 1.05 + oz;
  const c2 = 0.5 + 0.5 * Math.SQRT1_2 * 1.05 + oz;
  freeQuad(b, pi, uv, 1.0, a, 0, a2, c, 0, c2, c, 1, c2, a, 1, a2, true);
  freeQuad(b, pi, uv, 1.0, a, 0, c2, c, 0, a2, c, 1, a2, a, 1, c2, true);
}

/** Vanilla-style crop: four parallel planes so it reads from every angle. */
function emitCrop(b, id, meta, pi) {
  const uv = faceUVs(id, meta)[FACE_NORTH];
  const q = 4 / 16, r = 12 / 16;
  freeQuad(b, pi, uv, 1.0, 0, 0, q, 1, 0, q, 1, 1, q, 0, 1, q, true);
  freeQuad(b, pi, uv, 1.0, 0, 0, r, 1, 0, r, 1, 1, r, 0, 1, r, true);
  freeQuad(b, pi, uv, 1.0, q, 0, 0, q, 0, 1, q, 1, 1, q, 1, 0, true);
  freeQuad(b, pi, uv, 1.0, r, 0, 0, r, 0, 1, r, 1, 1, r, 1, 0, true);
}

/** Height of a fluid column with the given metadata (0..1). */
function fluidHeight(meta) {
  if (meta & 8) return 1;
  const l = meta & 7;
  return (8 - l) / 9;
}

/** Fluid height at one padded cell, or -1 when the cell is not this fluid. */
function fluidAt(i, id) {
  const v = pBlocks[i];
  if ((v & ID_MASK) !== id) return -1;
  return fluidHeight((v >>> 12) & 15);
}

/**
 * Corner height for a fluid surface: average of the four columns meeting at
 * that corner. A column with the same fluid directly above forces a full block
 * so waterfalls stay flush.
 */
function fluidCorner(pi, id, dx, dz, own) {
  let sum = 0, n = 0;
  for (let a = 0; a <= 1; a++) {
    for (let c = 0; c <= 1; c++) {
      const i = pi + (dx * a) * PSX + (dz * c) * PSZ;
      if (fluidAt(i + PSY, id) >= 0) return 1;
      const h = fluidAt(i, id);
      if (h >= 0) { sum += h; n++; }
      else if (!pOcc[i] && (pBlocks[i] & ID_MASK) === AIR_ID) { n++; }
    }
  }
  return n ? sum / n : own;
}

function emitFluid(b, id, meta, pi) {
  const def = getBlock(id);
  const level = meta & 15;
  const stillName = typeof def.tex === 'string' ? def.tex : (def.tex && def.tex.all) || def.name;
  const flowName = def.flowTex || stillName;
  const topUV = uvOf((level & 7) === 0 ? stillName : flowName);
  const sideUV = uvOf(flowName);

  const own = fluidHeight(level);
  const aboveSame = (pBlocks[pi + PSY] & ID_MASK) === id;
  const h00 = aboveSame ? 1 : fluidCorner(pi, id, -1, -1, own);
  const h10 = aboveSame ? 1 : fluidCorner(pi, id, 1, -1, own);
  const h11 = aboveSame ? 1 : fluidCorner(pi, id, 1, 1, own);
  const h01 = aboveSame ? 1 : fluidCorner(pi, id, -1, 1, own);
  // corner naming: h<x><z> with 0 = low side

  const l = curve(lightAt(pi));

  // top
  if (visible(id, pBlocks[pi + PSY])) {
    const sh = l * FACE_SHADE[FACE_UP];
    setCAll(sh * _tr, sh * _tg, sh * _tb);
    const uv = topUV;
    setP(0, 0, h01, 1); setP(1, 1, h11, 1); setP(2, 1, h10, 0); setP(3, 0, h00, 0);
    setUV(0, uv.u0, uv.v1); setUV(1, uv.u1, uv.v1); setUV(2, uv.u1, uv.v0); setUV(3, uv.u0, uv.v0);
    // The translucent material is double-sided, so the surface is already
    // visible from below when you swim under it. Emitting an explicit back
    // face here just doubled every water quad in the chunk.
    emitQuad(b, 0, 1, 0, false);
  }
  // bottom
  if (visible(id, pBlocks[pi - PSY])) {
    const sh = l * FACE_SHADE[FACE_DOWN];
    setCAll(sh * _tr, sh * _tg, sh * _tb);
    const uv = topUV;
    setP(0, 0, 0, 0); setP(1, 1, 0, 0); setP(2, 1, 0, 1); setP(3, 0, 0, 1);
    setUV(0, uv.u0, uv.v0); setUV(1, uv.u1, uv.v0); setUV(2, uv.u1, uv.v1); setUV(3, uv.u0, uv.v1);
    emitQuad(b, 0, -1, 0, false);
  }

  // sides: each edge interpolates between the two corner heights
  for (let k = 0; k < 4; k++) {
    let f, ni, ax, az, bx, bz, ha, hb;
    if (k === 0) { f = FACE_NORTH; ni = pi - PSZ; ax = 1; az = 0; bx = 0; bz = 0; ha = h10; hb = h00; }
    else if (k === 1) { f = FACE_SOUTH; ni = pi + PSZ; ax = 0; az = 1; bx = 1; bz = 1; ha = h01; hb = h11; }
    else if (k === 2) { f = FACE_WEST; ni = pi - PSX; ax = 0; az = 0; bx = 0; bz = 1; ha = h00; hb = h01; }
    else { f = FACE_EAST; ni = pi + PSX; ax = 1; az = 1; bx = 1; bz = 0; ha = h11; hb = h10; }
    if (!visible(id, pBlocks[ni])) continue;
    const sh = l * FACE_SHADE[f];
    setCAll(sh * _tr, sh * _tg, sh * _tb);
    const uv = sideUV;
    const vTopA = uv.v1 - (uv.v1 - uv.v0) * ha;
    const vTopB = uv.v1 - (uv.v1 - uv.v0) * hb;
    setP(0, ax, 0, az); setP(1, bx, 0, bz); setP(2, bx, hb, bz); setP(3, ax, ha, az);
    setUV(0, uv.u0, uv.v1); setUV(1, uv.u1, uv.v1); setUV(2, uv.u1, vTopB); setUV(3, uv.u0, vTopA);
    emitQuad(b, FACE_NX[f], FACE_NY[f], FACE_NZ[f], false);
  }
}

/** True when a fence / wall should grow an arm toward this neighbour. */
function fenceConnect(nv) {
  const nid = nv & ID_MASK;
  if (nid === AIR_ID) return false;
  if (T_OPAQUE[nid]) return true;
  return T_FENCEY[nid] === 1;
}

/** True when a pane / iron bar should connect toward this neighbour. */
function paneConnect(nv, selfId) {
  const nid = nv & ID_MASK;
  if (nid === AIR_ID) return false;
  if (nid === selfId) return true;
  if (T_OPAQUE[nid]) return true;
  return ID_GLASS_PANE_LIKE.has(nid) || T_FENCEY[nid] === 1;
}

function emitFence(b, id, meta, pi, smooth) {
  const n = fenceConnect(pBlocks[pi - PSZ]);
  const s = fenceConnect(pBlocks[pi + PSZ]);
  const w = fenceConnect(pBlocks[pi - PSX]);
  const e = fenceConnect(pBlocks[pi + PSX]);
  boxAll(b, pi, 6 * S, 0, 6 * S, 10 * S, 1, 10 * S, smooth);
  const y0a = 6 * S, y1a = 9 * S, y0b = 12 * S, y1b = 15 * S;
  if (n) {
    boxAll(b, pi, 7 * S, y0a, 0, 9 * S, y1a, 6 * S, smooth);
    boxAll(b, pi, 7 * S, y0b, 0, 9 * S, y1b, 6 * S, smooth);
  }
  if (s) {
    boxAll(b, pi, 7 * S, y0a, 10 * S, 9 * S, y1a, 1, smooth);
    boxAll(b, pi, 7 * S, y0b, 10 * S, 9 * S, y1b, 1, smooth);
  }
  if (w) {
    boxAll(b, pi, 0, y0a, 7 * S, 6 * S, y1a, 9 * S, smooth);
    boxAll(b, pi, 0, y0b, 7 * S, 6 * S, y1b, 9 * S, smooth);
  }
  if (e) {
    boxAll(b, pi, 10 * S, y0a, 7 * S, 1, y1a, 9 * S, smooth);
    boxAll(b, pi, 10 * S, y0b, 7 * S, 1, y1b, 9 * S, smooth);
  }
}

function emitWall(b, id, meta, pi, smooth) {
  const n = fenceConnect(pBlocks[pi - PSZ]);
  const s2 = fenceConnect(pBlocks[pi + PSZ]);
  const w = fenceConnect(pBlocks[pi - PSX]);
  const e = fenceConnect(pBlocks[pi + PSX]);
  const above = (pBlocks[pi + PSY] & ID_MASK) !== AIR_ID;
  const straightNS = n && s2 && !w && !e;
  const straightEW = w && e && !n && !s2;
  const top = above ? 1 : 14 * S;
  if (straightNS) {
    boxAll(b, pi, 5 * S, 0, 0, 11 * S, top, 1, smooth);
    return;
  }
  if (straightEW) {
    boxAll(b, pi, 0, 0, 5 * S, 1, top, 11 * S, smooth);
    return;
  }
  boxAll(b, pi, 4 * S, 0, 4 * S, 12 * S, 1, 12 * S, smooth);
  if (n) boxAll(b, pi, 5 * S, 0, 0, 11 * S, top, 5 * S, smooth);
  if (s2) boxAll(b, pi, 5 * S, 0, 11 * S, 11 * S, top, 1, smooth);
  if (w) boxAll(b, pi, 0, 0, 5 * S, 5 * S, top, 11 * S, smooth);
  if (e) boxAll(b, pi, 11 * S, 0, 5 * S, 1, top, 11 * S, smooth);
}

function emitFenceGate(b, id, meta, pi, smooth) {
  const facing = meta & 3;
  const open = (meta & 4) !== 0;
  const alongX = facing === 0 || facing === 2;   // gate spans the X axis
  const yLo = 5 * S, yHi = 1;
  if (alongX) {
    boxAll(b, pi, 0, yLo, 7 * S, 2 * S, yHi, 9 * S, smooth);
    boxAll(b, pi, 14 * S, yLo, 7 * S, 1, yHi, 9 * S, smooth);
    if (!open) {
      boxAll(b, pi, 2 * S, 6 * S, 7 * S, 14 * S, 9 * S, 9 * S, smooth);
      boxAll(b, pi, 2 * S, 12 * S, 7 * S, 14 * S, 15 * S, 9 * S, smooth);
      boxAll(b, pi, 6 * S, 9 * S, 7 * S, 10 * S, 12 * S, 9 * S, smooth);
    } else {
      boxAll(b, pi, 0, 6 * S, 9 * S, 2 * S, 15 * S, 1, smooth);
      boxAll(b, pi, 14 * S, 6 * S, 9 * S, 1, 15 * S, 1, smooth);
    }
  } else {
    boxAll(b, pi, 7 * S, yLo, 0, 9 * S, yHi, 2 * S, smooth);
    boxAll(b, pi, 7 * S, yLo, 14 * S, 9 * S, yHi, 1, smooth);
    if (!open) {
      boxAll(b, pi, 7 * S, 6 * S, 2 * S, 9 * S, 9 * S, 14 * S, smooth);
      boxAll(b, pi, 7 * S, 12 * S, 2 * S, 9 * S, 15 * S, 14 * S, smooth);
      boxAll(b, pi, 7 * S, 9 * S, 6 * S, 9 * S, 12 * S, 10 * S, smooth);
    } else {
      boxAll(b, pi, 9 * S, 6 * S, 0, 1, 15 * S, 2 * S, smooth);
      boxAll(b, pi, 9 * S, 6 * S, 14 * S, 1, 15 * S, 1, smooth);
    }
  }
}

function emitPane(b, id, meta, pi, smooth) {
  if (id === ID_NETHER_PORTAL) {
    // Portals are a single plane through the block on the meta-selected axis.
    if (meta & 1) boxAll(b, pi, 6 * S, 0, 0, 10 * S, 1, 1, smooth);
    else boxAll(b, pi, 0, 0, 6 * S, 1, 1, 10 * S, smooth);
    return;
  }
  const n = paneConnect(pBlocks[pi - PSZ], id);
  const s = paneConnect(pBlocks[pi + PSZ], id);
  const w = paneConnect(pBlocks[pi - PSX], id);
  const e = paneConnect(pBlocks[pi + PSX], id);
  const any = n || s || w || e;
  const a = 7 * S, c = 9 * S;
  if (!any) {
    boxAll(b, pi, a, 0, 0, c, 1, 1, smooth);
    boxAll(b, pi, 0, 0, a, 1, 1, c, smooth);
    return;
  }
  boxAll(b, pi, a, 0, a, c, 1, c, smooth);
  if (n) boxAll(b, pi, a, 0, 0, c, 1, a, smooth);
  if (s) boxAll(b, pi, a, 0, c, c, 1, 1, smooth);
  if (w) boxAll(b, pi, 0, 0, a, a, 1, c, smooth);
  if (e) boxAll(b, pi, c, 0, a, 1, 1, c, smooth);
}

function emitStairs(b, id, meta, pi, smooth) {
  const facing = meta & 3;
  const upsideDown = (meta & 4) !== 0;
  // Base half-slab.
  let bx0 = 0, by0 = upsideDown ? 0.5 : 0, bz0 = 0, bx1 = 1, by1 = upsideDown ? 1 : 0.5, bz1 = 1;
  emitBox(b, pi, bx0, by0, bz0, bx1, by1, bz1, cullMask(id, pi, bx0, by0, bz0, bx1, by1, bz1), smooth);
  // Step: the tall half sits opposite the facing direction.
  const sy0 = upsideDown ? 0 : 0.5, sy1 = upsideDown ? 0.5 : 1;
  let sx0 = 0, sz0 = 0, sx1 = 1, sz1 = 1;
  switch (facing) {
    case 0: sz0 = 0.5; break;        // facing north -> tall half to the south
    case 1: sx1 = 0.5; break;        // facing east  -> tall half to the west
    case 2: sz1 = 0.5; break;
    default: sx0 = 0.5; break;
  }
  emitBox(b, pi, sx0, sy0, sz0, sx1, sy1, sz1, cullMask(id, pi, sx0, sy0, sz0, sx1, sy1, sz1), smooth);
}

function emitTorch(b, id, meta, pi, smooth) {
  const m = meta & 7;
  const x0 = 7 * S, x1 = 9 * S, z0 = 7 * S, z1 = 9 * S, top = 10 * S;
  if (m === 0) {
    boxAll(b, pi, x0, 0, z0, x1, top, z1, false);
    return;
  }
  const d = (m - 1) & 3;
  const dx = HDX[d], dz = HDZ[d];
  _shOn = true;
  _shX = dx * 0.45; _shZ = dz * 0.45; _shPivot = 0.2;
  const offX = -dx * 0.3, offZ = -dz * 0.3;
  boxAll(b, pi, x0 + offX, 0.2, z0 + offZ, x1 + offX, 0.2 + top, z1 + offZ, false);
  _shOn = false;
}

function emitEndRod(b, id, meta, pi, smooth) {
  const axis = meta & 3;
  if (axis === 1) {
    boxAll(b, pi, 0, 7 * S, 7 * S, 1, 9 * S, 9 * S, smooth);
    boxAll(b, pi, 0, 6 * S, 6 * S, S, 10 * S, 10 * S, smooth);
  } else if (axis === 2) {
    boxAll(b, pi, 7 * S, 7 * S, 0, 9 * S, 9 * S, 1, smooth);
    boxAll(b, pi, 6 * S, 6 * S, 0, 10 * S, 10 * S, S, smooth);
  } else {
    boxAll(b, pi, 7 * S, 0, 7 * S, 9 * S, 1, 9 * S, smooth);
    boxAll(b, pi, 6 * S, 0, 6 * S, 10 * S, S, 10 * S, smooth);
  }
}

function emitLantern(b, id, meta, pi, smooth) {
  const hanging = (meta & 1) !== 0;
  if (hanging) {
    boxAll(b, pi, 5 * S, S, 5 * S, 11 * S, 8 * S, 11 * S, smooth);
    boxAll(b, pi, 6 * S, 8 * S, 6 * S, 10 * S, 10 * S, 10 * S, smooth);
    boxAll(b, pi, 7 * S, 10 * S, 7 * S, 9 * S, 1, 9 * S, smooth);
  } else {
    boxAll(b, pi, 5 * S, 0, 5 * S, 11 * S, 7 * S, 11 * S, smooth);
    boxAll(b, pi, 6 * S, 7 * S, 6 * S, 10 * S, 9 * S, 10 * S, smooth);
  }
}

function emitDoor(b, id, meta, pi, smooth) {
  let facing = (meta >> 1) & 3;
  const open = (meta & 8) !== 0;
  if (open) facing = (facing + 1) & 3;
  const t = 3 * S;
  let x0 = 0, y0 = 0, z0 = 0, x1 = 1, y1 = 1, z1 = 1;
  switch (facing) {
    case 0: z1 = t; break;
    case 1: x0 = 1 - t; break;
    case 2: z0 = 1 - t; break;
    default: x1 = t; break;
  }
  boxAll(b, pi, x0, y0, z0, x1, y1, z1, smooth);
}

function emitTrapdoor(b, id, meta, pi, smooth) {
  const facing = meta & 3;
  const open = (meta & 4) !== 0;
  const top = (meta & 8) !== 0;
  const t = 3 * S;
  if (!open) {
    if (top) boxAll(b, pi, 0, 1 - t, 0, 1, 1, 1, smooth);
    else boxAll(b, pi, 0, 0, 0, 1, t, 1, smooth);
    return;
  }
  switch (facing) {
    case 0: boxAll(b, pi, 0, 0, 0, 1, 1, t, smooth); break;
    case 1: boxAll(b, pi, 1 - t, 0, 0, 1, 1, 1, smooth); break;
    case 2: boxAll(b, pi, 0, 0, 1 - t, 1, 1, 1, smooth); break;
    default: boxAll(b, pi, 0, 0, 0, t, 1, 1, smooth); break;
  }
}

function emitLadder(b, id, meta, pi, smooth) {
  const facing = meta & 3;    // direction the ladder faces (away from its wall)
  const t = 2 * S;
  switch (facing) {
    case 0: boxAll(b, pi, 0, 0, 1 - t, 1, 1, 1, smooth); break;
    case 1: boxAll(b, pi, 0, 0, 0, t, 1, 1, smooth); break;
    case 2: boxAll(b, pi, 0, 0, 0, 1, 1, t, smooth); break;
    default: boxAll(b, pi, 1 - t, 0, 0, 1, 1, 1, smooth); break;
  }
}

function emitCactus(b, id, meta, pi, smooth) {
  // Top and bottom are full-size; the four sides are inset by one pixel.
  let m = 0;
  if (visible(id, pBlocks[pi + PSY])) m |= 1 << FACE_UP;
  if (visible(id, pBlocks[pi - PSY])) m |= 1 << FACE_DOWN;
  if (m) emitBox(b, pi, 0, 0, 0, 1, 1, 1, m, smooth);
  let sm = 0;
  if (visible(id, pBlocks[pi - PSZ])) sm |= 1 << FACE_NORTH;
  if (visible(id, pBlocks[pi + PSZ])) sm |= 1 << FACE_SOUTH;
  if (visible(id, pBlocks[pi - PSX])) sm |= 1 << FACE_WEST;
  if (visible(id, pBlocks[pi + PSX])) sm |= 1 << FACE_EAST;
  if (sm) emitBox(b, pi, S, 0, S, 1 - S, 1, 1 - S, sm, smooth);
}

function emitChest(b, id, meta, pi, smooth) {
  boxAll(b, pi, S, 0, S, 1 - S, 14 * S, 1 - S, smooth);
  const facing = meta & 3;
  // A small latch nub poking out of the front face.
  switch (facing) {
    case 0: boxAll(b, pi, 7 * S, 7 * S, 0, 9 * S, 11 * S, S, smooth); break;
    case 1: boxAll(b, pi, 1 - S, 7 * S, 7 * S, 1, 11 * S, 9 * S, smooth); break;
    case 2: boxAll(b, pi, 7 * S, 7 * S, 1 - S, 9 * S, 11 * S, 1, smooth); break;
    default: boxAll(b, pi, 0, 7 * S, 7 * S, S, 11 * S, 9 * S, smooth); break;
  }
}

function emitBed(b, id, meta, pi, smooth) {
  boxAll(b, pi, 0, 3 * S, 0, 1, 9 * S, 1, smooth);
  boxAll(b, pi, 0, 0, 0, 3 * S, 3 * S, 3 * S, smooth);
  boxAll(b, pi, 13 * S, 0, 13 * S, 1, 3 * S, 1, smooth);
  boxAll(b, pi, 13 * S, 0, 0, 1, 3 * S, 3 * S, smooth);
  boxAll(b, pi, 0, 0, 13 * S, 3 * S, 3 * S, 1, smooth);
}

function emitSign(b, id, meta, pi, smooth) {
  boxAll(b, pi, 7 * S, 0, 7 * S, 9 * S, 9 * S, 9 * S, smooth);
  boxAll(b, pi, S, 9 * S, 7 * S, 15 * S, 1, 9 * S, smooth);
}

function emitWallSign(b, id, meta, pi, smooth) {
  const facing = meta & 3;
  const t = 2 * S;
  switch (facing) {
    case 0: boxAll(b, pi, 0, 4 * S, 0, 1, 12 * S, t, smooth); break;
    case 1: boxAll(b, pi, 1 - t, 4 * S, 0, 1, 12 * S, 1, smooth); break;
    case 2: boxAll(b, pi, 0, 4 * S, 1 - t, 1, 12 * S, 1, smooth); break;
    default: boxAll(b, pi, 0, 4 * S, 0, t, 12 * S, 1, smooth); break;
  }
}

/** Shared placement for buttons and lever bases: meta 0 floor, 1..4 wall, 5 ceiling. */
function wallMountBox(m, w, h, t, out) {
  const half = w / 2;
  if (m === 0) { out[0] = 0.5 - half; out[1] = 0; out[2] = 0.5 - h / 2; out[3] = 0.5 + half; out[4] = t; out[5] = 0.5 + h / 2; return; }
  if (m === 5) { out[0] = 0.5 - half; out[1] = 1 - t; out[2] = 0.5 - h / 2; out[3] = 0.5 + half; out[4] = 1; out[5] = 0.5 + h / 2; return; }
  const d = (m - 1) & 3;
  const dx = HDX[d], dz = HDZ[d];
  const cy0 = 0.5 - h / 2, cy1 = 0.5 + h / 2;
  if (dx !== 0) {
    const x0 = dx > 0 ? 0 : 1 - t, x1 = dx > 0 ? t : 1;
    out[0] = x0; out[1] = cy0; out[2] = 0.5 - half; out[3] = x1; out[4] = cy1; out[5] = 0.5 + half;
  } else {
    const z0 = dz > 0 ? 0 : 1 - t, z1 = dz > 0 ? t : 1;
    out[0] = 0.5 - half; out[1] = cy0; out[2] = z0; out[3] = 0.5 + half; out[4] = cy1; out[5] = z1;
  }
}

const _mb = new Float32Array(6);

function emitButton(b, id, meta, pi, smooth) {
  const m = meta & 7;
  const pressed = (meta & 8) !== 0;
  wallMountBox(m, 6 * S, 4 * S, pressed ? S : 2 * S, _mb);
  boxAll(b, pi, _mb[0], _mb[1], _mb[2], _mb[3], _mb[4], _mb[5], smooth);
}

function emitLever(b, id, meta, pi, smooth) {
  const m = meta & 7;
  const on = (meta & 8) !== 0;
  wallMountBox(m, 6 * S, 8 * S, 3 * S, _mb);
  boxAll(b, pi, _mb[0], _mb[1], _mb[2], _mb[3], _mb[4], _mb[5], smooth);
  // Handle: a small post leaning forward or back depending on the state.
  const cx = (_mb[0] + _mb[3]) / 2, cy = (_mb[1] + _mb[4]) / 2, cz = (_mb[2] + _mb[5]) / 2;
  _shOn = true;
  _shPivot = cy;
  if (m === 0 || m === 5) { _shX = 0; _shZ = on ? 0.5 : -0.5; }
  else {
    const d = (m - 1) & 3;
    _shX = HDX[d] * (on ? 0.5 : -0.5);
    _shZ = HDZ[d] * (on ? 0.5 : -0.5);
  }
  boxAll(b, pi, cx - S, cy, cz - S, cx + S, cy + 8 * S, cz + S, false);
  _shOn = false;
}

function emitAnvil(b, id, meta, pi, smooth) {
  const facing = meta & 3;
  const rot = facing === 1 || facing === 3;
  const bx = (x0, y0, z0, x1, y1, z1) => {
    if (rot) boxAll(b, pi, z0, y0, x0, z1, y1, x1, smooth);
    else boxAll(b, pi, x0, y0, z0, x1, y1, z1, smooth);
  };
  bx(2 * S, 0, 2 * S, 14 * S, 4 * S, 14 * S);
  bx(4 * S, 4 * S, 5 * S, 12 * S, 5 * S, 11 * S);
  bx(6 * S, 5 * S, 4 * S, 10 * S, 10 * S, 12 * S);
  bx(0, 10 * S, 3 * S, 1, 1, 13 * S);
}

function emitCauldron(b, id, meta, pi, smooth) {
  const def = getBlock(id);
  boxAll(b, pi, 0, 0, 0, 1, 3 * S, 1, smooth);
  boxAll(b, pi, 0, 3 * S, 0, 2 * S, 1, 1, smooth);
  boxAll(b, pi, 14 * S, 3 * S, 0, 1, 1, 1, smooth);
  boxAll(b, pi, 2 * S, 3 * S, 0, 14 * S, 1, 2 * S, smooth);
  boxAll(b, pi, 2 * S, 3 * S, 14 * S, 14 * S, 1, 1, smooth);
  const inner = def.tex && typeof def.tex === 'object' ? def.tex.inner : null;
  if (inner) {
    // Composters count 0..7, filled cauldrons 1..3, and the plain empty
    // cauldron has no contents at all. `(meta & 3) || 3` applied to all of them
    // drew an empty cauldron brim-full and every composter as full.
    const composter = def.name === 'composter';
    const max = composter ? 7 : 3;
    const level = composter ? (meta & 7)
      : def.name === 'cauldron' ? 0
        : ((meta & 3) || 3);
    if (level > 0) {
      const h = 3 * S + (level / max) * (12 * S);
      const uv = uvOf(inner);
      freeQuad(b, pi, uv, 1.0, 2 * S, h, 14 * S, 14 * S, h, 14 * S, 14 * S, h, 2 * S, 2 * S, h, 2 * S, false);
    }
  }
}

function emitHopper(b, id, meta, pi, smooth) {
  boxAll(b, pi, 0, 10 * S, 0, 1, 1, 2 * S, smooth);
  boxAll(b, pi, 0, 10 * S, 14 * S, 1, 1, 1, smooth);
  boxAll(b, pi, 0, 10 * S, 2 * S, 2 * S, 1, 14 * S, smooth);
  boxAll(b, pi, 14 * S, 10 * S, 2 * S, 1, 1, 14 * S, smooth);
  boxAll(b, pi, 0, 4 * S, 0, 1, 10 * S, 1, smooth);
  // Hopper meta is a plain 4-way facing; the old >= 2 test hid the spout on
  // hoppers placed facing north or east.
  const facing = meta & 3;
  boxAll(b, pi, 6 * S, 0, 6 * S, 10 * S, 4 * S, 10 * S, smooth);
  if (facing >= 0) {
    const dx = HDX[facing], dz = HDZ[facing];
    boxAll(b, pi,
      Math.min(6 * S + dx * 4 * S, 6 * S), S, Math.min(6 * S + dz * 4 * S, 6 * S),
      Math.max(10 * S + dx * 4 * S, 10 * S), 3 * S, Math.max(10 * S + dz * 4 * S, 10 * S), smooth);
  }
  const def = getBlock(id);
  const inner = def.tex && typeof def.tex === 'object' ? def.tex.inner : null;
  if (inner) {
    const uv = uvOf(inner);
    freeQuad(b, pi, uv, 1.0, 0, 10 * S, 1, 1, 10 * S, 1, 1, 10 * S, 0, 0, 10 * S, 0, false);
  }
}

function emitPiston(b, id, meta, pi, smooth) {
  const facing = meta & 7;
  const extended = (meta & 8) !== 0;
  const def = getBlock(id);
  const tex = def.tex && typeof def.tex === 'object' ? def.tex : null;
  const sideName = tex ? tex.side || def.name : def.name;
  const frontName = tex ? tex.front || sideName : sideName;
  const backName = tex ? tex.bottom || sideName : sideName;
  const opp = facing ^ 1;
  for (let f = 0; f < 6; f++) {
    _fuv[f] = uvOf(f === facing ? frontName : f === opp ? backName : sideName);
  }
  let x0 = 0, y0 = 0, z0 = 0, x1 = 1, y1 = 1, z1 = 1;
  if (extended) {
    const d = 4 * S;
    switch (facing) {
      case FACE_DOWN: y0 = d; break;
      case FACE_UP: y1 = 1 - d; break;
      case FACE_NORTH: z0 = d; break;
      case FACE_SOUTH: z1 = 1 - d; break;
      case FACE_WEST: x0 = d; break;
      default: x1 = 1 - d; break;
    }
  }
  emitBox(b, pi, x0, y0, z0, x1, y1, z1, cullMask(id, pi, x0, y0, z0, x1, y1, z1), smooth);
}

function emitPistonHead(b, id, meta, pi, smooth) {
  const facing = meta & 7;
  const plate = 4 * S, rod = 12 * S;
  switch (facing) {
    case FACE_DOWN:
      boxAll(b, pi, 0, 0, 0, 1, plate, 1, smooth);
      boxAll(b, pi, 6 * S, plate, 6 * S, 10 * S, plate + rod, 10 * S, smooth);
      break;
    case FACE_UP:
      boxAll(b, pi, 0, 1 - plate, 0, 1, 1, 1, smooth);
      boxAll(b, pi, 6 * S, 1 - plate - rod, 6 * S, 10 * S, 1 - plate, 10 * S, smooth);
      break;
    case FACE_NORTH:
      boxAll(b, pi, 0, 0, 0, 1, 1, plate, smooth);
      boxAll(b, pi, 6 * S, 6 * S, plate, 10 * S, 10 * S, plate + rod, smooth);
      break;
    case FACE_SOUTH:
      boxAll(b, pi, 0, 0, 1 - plate, 1, 1, 1, smooth);
      boxAll(b, pi, 6 * S, 6 * S, 1 - plate - rod, 10 * S, 10 * S, 1 - plate, smooth);
      break;
    case FACE_WEST:
      boxAll(b, pi, 0, 0, 0, plate, 1, 1, smooth);
      boxAll(b, pi, plate, 6 * S, 6 * S, plate + rod, 10 * S, 10 * S, smooth);
      break;
    default:
      boxAll(b, pi, 1 - plate, 0, 0, 1, 1, 1, smooth);
      boxAll(b, pi, 1 - plate - rod, 6 * S, 6 * S, 1 - plate, 10 * S, 10 * S, smooth);
      break;
  }
}

function emitRail(b, id, meta, pi) {
  const def = getBlock(id);
  // Only the plain rail uses all four meta bits for its ten shapes. Powered,
  // detector and activator rails keep bit 3 for their powered state and have
  // just six shapes, so masking all of them with 15 made every powered rail
  // snap to a corner or ascending piece the moment it was switched on.
  const curved = def.name === 'rail';
  const raw = curved ? (meta & 15) : (meta & 7);
  const shape = curved ? (raw > 9 ? 0 : raw) : (raw > 5 ? 0 : raw);
  let name = typeof def.tex === 'string' ? def.tex : def.name;
  if (shape >= 6) {
    const corner = name + '_corner';
    if (Atlas.has(corner)) name = corner;
  }
  const uv = uvOf(name);
  const h = S;
  const alongX = shape === 1 || shape === 2 || shape === 3;
  let y00 = h, y10 = h, y11 = h, y01 = h;   // corner heights: y<x><z>
  if (shape === 2) { y10 = 1 + h; y11 = 1 + h; }        // ascending east (+X)
  else if (shape === 3) { y00 = 1 + h; y01 = 1 + h; }   // ascending west
  else if (shape === 4) { y00 = 1 + h; y10 = 1 + h; }   // ascending north (-Z)
  else if (shape === 5) { y01 = 1 + h; y11 = 1 + h; }   // ascending south

  const l = curve(lightAt(pi));
  setCAll(l * _tr, l * _tg, l * _tb);
  setP(0, 0, y01, 1); setP(1, 1, y11, 1); setP(2, 1, y10, 0); setP(3, 0, y00, 0);
  if (alongX) {
    setUV(0, uv.u1, uv.v1); setUV(1, uv.u1, uv.v0); setUV(2, uv.u0, uv.v0); setUV(3, uv.u0, uv.v1);
  } else {
    setUV(0, uv.u0, uv.v1); setUV(1, uv.u1, uv.v1); setUV(2, uv.u1, uv.v0); setUV(3, uv.u0, uv.v0);
  }
  // Rails land in the double-sided cutout material, so the reversed copy was a
  // coplanar duplicate.
  emitQuad(b, 0, 1, 0, false);
}

function emitVine(b, id, meta, pi) {
  const uv = faceUVs(id, meta)[FACE_NORTH];
  const m = meta & 15;
  const o = S * 0.6;
  let any = false;
  if (m & 1) { // south (+Z)
    freeQuad(b, pi, uv, 0.8, 0, 0, 1 - o, 1, 0, 1 - o, 1, 1, 1 - o, 0, 1, 1 - o, true); any = true;
  }
  if (m & 2) { // west (-X)
    freeQuad(b, pi, uv, 0.6, o, 0, 1, o, 0, 0, o, 1, 0, o, 1, 1, true); any = true;
  }
  if (m & 4) { // north (-Z)
    freeQuad(b, pi, uv, 0.8, 1, 0, o, 0, 0, o, 0, 1, o, 1, 1, o, true); any = true;
  }
  if (m & 8) { // east (+X)
    freeQuad(b, pi, uv, 0.6, 1 - o, 0, 0, 1 - o, 0, 1, 1 - o, 1, 1, 1 - o, 1, 0, true); any = true;
  }
  if (!any) {
    freeQuad(b, pi, uv, 1.0, 0, 1 - o, 1, 1, 1 - o, 1, 1, 1 - o, 0, 0, 1 - o, 0, true);
  }
}

function emitSkull(b, id, meta, pi, smooth) {
  const m = meta & 7;
  if (m < 4) {
    boxAll(b, pi, 4 * S, 0, 4 * S, 12 * S, 8 * S, 12 * S, smooth);
    return;
  }
  const d = (m - 4) & 3;
  const dx = HDX[d], dz = HDZ[d];
  const cx = 0.5 - dx * 4 * S, cz = 0.5 - dz * 4 * S;
  boxAll(b, pi, cx - 4 * S, 4 * S, cz - 4 * S, cx + 4 * S, 12 * S, cz + 4 * S, smooth);
}

function emitFlat(b, id, meta, pi) {
  const def = getBlock(id);
  if (def.boxes && def.boxes.length) {
    const bx = def.boxes[0];
    boxAll(b, pi, bx[0], bx[1], bx[2], bx[3], bx[4], bx[5], false);
    return;
  }
  if (T_TINT[id] === 4 || def.name === 'tripwire') {
    const uv = faceUVs(id, meta)[FACE_UP];
    const y = S * 0.6;
    freeQuad(b, pi, uv, 1.0, 0, y, 1, 1, y, 1, 1, y, 0, 0, y, 0, true);
    return;
  }
  boxAll(b, pi, S, 0, S, 15 * S, S, 15 * S, false);
}

function emitPot(b, id, meta, pi, smooth) {
  boxAll(b, pi, 5 * S, 0, 5 * S, 11 * S, 6 * S, 11 * S, smooth);
}

// ---------------------------------------------------------------------------
// Per-block dispatch
// ---------------------------------------------------------------------------
function emitBlock(id, meta, pi, wx, wy, wz, smooth) {
  const model = T_MODEL[id];
  if (model === MODEL_NONE || T_AIR[id]) return;
  const def = BLOCKS[id];
  if (!def) return;
  const pass = T_PASS[id];
  const b = BUILDERS[pass];

  _ox = wx; _oy = wy; _oz = wz;
  _shOn = false;
  _curId = id;

  // Tint + which faces it applies to.
  const px = (wx & 15) + 1, pz = (wz & 15) + 1;
  const kind = computeTint(id, meta, px, wy + 1, pz, wy);
  _tr = _tint[0]; _tg = _tint[1]; _tb = _tint[2];
  _tintMask = kind === 0 ? 0 : T_TINT_FACES[id];

  fillUVFromBlock(id, meta);

  const custom = CUSTOM_SHAPE[id];
  if (custom) {
    for (let k = 0; k < custom.length; k++) {
      const s = custom[k];
      const mask = custom.length === 1
        ? cullMask(id, pi, s[0], s[1], s[2], s[3], s[4], s[5])
        : 0x3f;
      emitBox(b, pi, s[0], s[1], s[2], s[3], s[4], s[5], mask, smooth);
    }
    emitOverlay(id, meta, pi, smooth);
    return;
  }

  switch (model) {
    case MODEL_CUBE:
    case MODEL_FARMLAND:
      emitBox(b, pi, 0, 0, 0, 1, 1, 1, cullMask(id, pi, 0, 0, 0, 1, 1, 1), smooth);
      break;
    case MODEL_PATH:
      emitBox(b, pi, 0, 0, 0, 1, 15 * S, 1, cullMask(id, pi, 0, 0, 0, 1, 15 * S, 1), smooth);
      break;
    case MODEL_SLAB: {
      const top = (meta & 1) !== 0;
      const y0 = top ? 0.5 : 0, y1 = top ? 1 : 0.5;
      emitBox(b, pi, 0, y0, 0, 1, y1, 1, cullMask(id, pi, 0, y0, 0, 1, y1, 1), smooth);
      break;
    }
    case MODEL_STAIRS: emitStairs(b, id, meta, pi, smooth); break;
    case MODEL_LAYER: {
      const h = ((meta & 7) + 1) * 2 * S;
      emitBox(b, pi, 0, 0, 0, 1, h, 1, cullMask(id, pi, 0, 0, 0, 1, h, 1), smooth);
      break;
    }
    case MODEL_CARPET:
      emitBox(b, pi, 0, 0, 0, 1, S, 1, cullMask(id, pi, 0, 0, 0, 1, S, 1), smooth);
      break;
    case MODEL_CROSS: emitCross(b, id, meta, pi, wx, wy, wz); break;
    case MODEL_CROP:
      if (id === ID_COCOA) {
        const stage = Math.min(2, meta & 3);
        const w = (4 + stage * 2) * S, hh = (5 + stage * 2) * S;
        // Facing points at the trunk the pod hangs from, and the rest of the
        // codebase (ladder, wall_sign) puts the model against the -facing side,
        // so flip it or every pod floats on the wrong side of its log.
        const facing = (((meta >> 2) & 3) + 2) & 3;
        const dx = HDX[facing], dz = HDZ[facing];
        const cx = 0.5 + dx * (0.5 - w / 2 - S), cz = 0.5 + dz * (0.5 - w / 2 - S);
        boxAll(b, pi, cx - w / 2, 12 * S - hh, cz - w / 2, cx + w / 2, 12 * S, cz + w / 2, false);
      } else {
        emitCrop(b, id, meta, pi);
      }
      break;
    case MODEL_FLUID: emitFluid(b, id, meta, pi); break;
    case MODEL_FENCE: emitFence(b, id, meta, pi, smooth); break;
    case MODEL_FENCE_GATE: emitFenceGate(b, id, meta, pi, smooth); break;
    case MODEL_WALL: emitWall(b, id, meta, pi, smooth); break;
    case MODEL_PANE: emitPane(b, id, meta, pi, smooth); break;
    case MODEL_TORCH: emitTorch(b, id, meta, pi, smooth); break;
    case MODEL_FLAT: emitFlat(b, id, meta, pi); break;
    case MODEL_DOOR: emitDoor(b, id, meta, pi, smooth); break;
    case MODEL_TRAPDOOR: emitTrapdoor(b, id, meta, pi, smooth); break;
    case MODEL_LADDER: emitLadder(b, id, meta, pi, smooth); break;
    case MODEL_CACTUS: emitCactus(b, id, meta, pi, smooth); break;
    case MODEL_CHEST: emitChest(b, id, meta, pi, smooth); break;
    case MODEL_BED: emitBed(b, id, meta, pi, smooth); break;
    case MODEL_SIGN: emitSign(b, id, meta, pi, smooth); break;
    case MODEL_WALL_SIGN: emitWallSign(b, id, meta, pi, smooth); break;
    case MODEL_BUTTON: emitButton(b, id, meta, pi, smooth); break;
    case MODEL_LEVER: emitLever(b, id, meta, pi, smooth); break;
    case MODEL_ANVIL: emitAnvil(b, id, meta, pi, smooth); break;
    case MODEL_CAULDRON: emitCauldron(b, id, meta, pi, smooth); break;
    case MODEL_HOPPER: emitHopper(b, id, meta, pi, smooth); break;
    case MODEL_END_ROD: emitEndRod(b, id, meta, pi, smooth); break;
    case MODEL_LANTERN: emitLantern(b, id, meta, pi, smooth); break;
    case MODEL_PISTON: emitPiston(b, id, meta, pi, smooth); break;
    case MODEL_PISTON_HEAD: emitPistonHead(b, id, meta, pi, smooth); break;
    case MODEL_RAIL: emitRail(b, id, meta, pi); break;
    case MODEL_VINE: emitVine(b, id, meta, pi); break;
    case MODEL_SKULL: emitSkull(b, id, meta, pi, smooth); break;
    case MODEL_POT: emitPot(b, id, meta, pi, smooth); break;
    default:
      // Anything unhandled falls back to a full cube so nothing disappears.
      emitBox(b, pi, 0, 0, 0, 1, 1, 1, cullMask(id, pi, 0, 0, 0, 1, 1, 1), smooth);
      break;
  }

  emitOverlay(id, meta, pi, smooth);
}

/**
 * Grass-block style side overlays: a tinted decal quad laid a hair proud of the
 * side faces so the untinted dirt texture shows through underneath.
 */
function emitOverlay(id, meta, pi, smooth) {
  const def = BLOCKS[id];
  if (!def || !def.overlay) return;
  if (T_MODEL[id] !== MODEL_CUBE) return;
  const uv = uvOf(def.overlay);
  const ob = BUILDERS[1];
  const eps = 0.0015;
  const saveMask = _tintMask;
  _tintMask = 0x3f;
  for (let f = 2; f < 6; f++) {
    if (!visible(id, pBlocks[pi + (f === 2 ? -PSZ : f === 3 ? PSZ : f === 4 ? -PSX : PSX)])) continue;
    for (let k = 0; k < 6; k++) _fuv[k] = uv;
    const x0 = f === 4 ? -eps : f === 5 ? 1 + eps : 0;
    const x1 = f === 4 ? -eps : f === 5 ? 1 + eps : 1;
    const z0 = f === 2 ? -eps : f === 3 ? 1 + eps : 0;
    const z1 = f === 2 ? -eps : f === 3 ? 1 + eps : 1;
    emitBox(ob, pi, x0, 0, z0, x1, 1, z1, 1 << f, smooth);
  }
  _tintMask = saveMask;
  fillUVFromBlock(id, meta);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Builds render geometry for one chunk.
 * @returns {{opaque: object|null, cutout: object|null, translucent: object|null}}
 *   Each pass is either null (nothing to draw) or
 *   { position, normal, uv, color: Float32Array, index: Uint32Array }.
 *   Positions are in WORLD space.
 */
export function meshChunk(world, chunk) {
  if (!world || !chunk) return { opaque: null, cutout: null, translucent: null };
  resetBuilders();
  if (chunk.empty) return { opaque: null, cutout: null, translucent: null };

  loadNeighborhood(world, chunk);

  const smooth = !(world.smoothLighting === false);
  const blocks = chunk.blocks;
  const ox = chunk.cx << 4, oz = chunk.cz << 4;

  for (let s = 0; s < SECTION_COUNT; s++) {
    if (chunk.isEmptySection && chunk.isEmptySection(s)) continue;
    const yTop = Math.min((s << 4) + 16, WORLD_HEIGHT);
    for (let y = s << 4; y < yTop; y++) {
      const py = y + 1;
      for (let z = 0; z < 16; z++) {
        const src = (y << 8) | (z << 4);
        const pRow = py * PSY + (z + 1) * PSZ + 1;
        for (let x = 0; x < 16; x++) {
          const v = blocks[src + x];
          const id = v & ID_MASK;
          if (id === AIR_ID) continue;
          emitBlock(id, (v >>> 12) & 15, pRow + x, ox + x, y, oz + z, smooth);
        }
      }
    }
  }

  return {
    opaque: finish(B_OPAQUE),
    cutout: finish(B_CUTOUT),
    translucent: finish(B_TRANS),
  };
}

// ---------------------------------------------------------------------------
// Collision / selection shapes
// ---------------------------------------------------------------------------
const FULL_BOX = [[0, 0, 0, 1, 1, 1]];
const NO_BOX = Object.freeze([]);
const _collCache = new Map();
const _selCache = new Map();

/** Untranslated collision template for one (id, meta) pair. */
function collisionTemplate(id, meta) {
  const def = getBlock(id);
  const model = T_MODEL[id];
  const m = meta & 15;
  if (id === ID_SOUL_SAND) return SOUL_SAND_BOX;
  // Walk-through blocks never collide, whatever their rendered shape is.
  if (def.collision === 'none') return model === MODEL_NONE && def.solid ? FULL_BOX : NO_BOX;

  switch (model) {
    case MODEL_NONE:
      return def.collision === 'full' ? FULL_BOX : NO_BOX;
    case MODEL_FLUID:
      return NO_BOX;
    case MODEL_SLAB: {
      const top = (m & 1) !== 0;
      return top ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.5, 1]];
    }
    case MODEL_STAIRS: {
      const facing = m & 3;
      const ud = (m & 4) !== 0;
      const base = ud ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
      const sy0 = ud ? 0 : 0.5, sy1 = ud ? 0.5 : 1;
      let sx0 = 0, sz0 = 0, sx1 = 1, sz1 = 1;
      if (facing === 0) sz0 = 0.5;
      else if (facing === 1) sx1 = 0.5;
      else if (facing === 2) sz1 = 0.5;
      else sx0 = 0.5;
      return [base, [sx0, sy0, sz0, sx1, sy1, sz1]];
    }
    case MODEL_FENCE:
    case MODEL_FENCE_GATE:
      return (m & 4) && model === MODEL_FENCE_GATE ? NO_BOX : [[0, 0, 0, 1, 1.5, 1]];
    case MODEL_WALL:
      return [[0, 0, 0, 1, 1.5, 1]];
    case MODEL_PANE:
      if (id === ID_NETHER_PORTAL) return NO_BOX;
      return [[7 * S, 0, 0, 9 * S, 1, 1], [0, 0, 7 * S, 1, 1, 9 * S]];
    case MODEL_LAYER: {
      const h = (m & 7) * 2 * S;
      return h <= 0 ? NO_BOX : [[0, 0, 0, 1, h, 1]];
    }
    case MODEL_CARPET:
      return def.boxes && def.boxes.length ? def.boxes : [[0, 0, 0, 1, S, 1]];
    case MODEL_CACTUS:
      return [[S, 0, S, 15 * S, 15 * S, 15 * S]];
    case MODEL_FARMLAND:
      return [[0, 0, 0, 1, 15 * S, 1]];
    case MODEL_PATH:
      return [[0, 0, 0, 1, 15 * S, 1]];
    case MODEL_DOOR: {
      let facing = (m >> 1) & 3;
      if (m & 8) facing = (facing + 1) & 3;
      const t = 3 * S;
      if (facing === 0) return [[0, 0, 0, 1, 1, t]];
      if (facing === 1) return [[1 - t, 0, 0, 1, 1, 1]];
      if (facing === 2) return [[0, 0, 1 - t, 1, 1, 1]];
      return [[0, 0, 0, t, 1, 1]];
    }
    case MODEL_TRAPDOOR: {
      const t = 3 * S;
      if (!(m & 4)) return (m & 8) ? [[0, 1 - t, 0, 1, 1, 1]] : [[0, 0, 0, 1, t, 1]];
      const facing = m & 3;
      if (facing === 0) return [[0, 0, 0, 1, 1, t]];
      if (facing === 1) return [[1 - t, 0, 0, 1, 1, 1]];
      if (facing === 2) return [[0, 0, 1 - t, 1, 1, 1]];
      return [[0, 0, 0, t, 1, 1]];
    }
    case MODEL_LADDER:
      return NO_BOX;
    case MODEL_CAULDRON:
      return [
        [0, 0, 0, 1, 3 * S, 1],
        [0, 3 * S, 0, 2 * S, 1, 1], [14 * S, 3 * S, 0, 1, 1, 1],
        [2 * S, 3 * S, 0, 14 * S, 1, 2 * S], [2 * S, 3 * S, 14 * S, 14 * S, 1, 1],
      ];
    case MODEL_HOPPER:
      return [
        [0, 10 * S, 0, 1, 1, 2 * S], [0, 10 * S, 14 * S, 1, 1, 1],
        [0, 10 * S, 2 * S, 2 * S, 1, 14 * S], [14 * S, 10 * S, 2 * S, 1, 1, 14 * S],
        [0, 0, 0, 1, 10 * S, 1],
      ];
    case MODEL_PISTON: {
      if (!(m & 8)) return FULL_BOX;
      const facing = m & 7;
      const d = 4 * S;
      if (facing === FACE_DOWN) return [[0, d, 0, 1, 1, 1]];
      if (facing === FACE_UP) return [[0, 0, 0, 1, 1 - d, 1]];
      if (facing === FACE_NORTH) return [[0, 0, d, 1, 1, 1]];
      if (facing === FACE_SOUTH) return [[0, 0, 0, 1, 1, 1 - d]];
      if (facing === FACE_WEST) return [[d, 0, 0, 1, 1, 1]];
      return [[0, 0, 0, 1 - d, 1, 1]];
    }
    case MODEL_PISTON_HEAD: {
      const facing = m & 7;
      const plate = 4 * S;
      if (facing === FACE_DOWN) return [[0, 0, 0, 1, plate, 1]];
      if (facing === FACE_UP) return [[0, 1 - plate, 0, 1, 1, 1]];
      if (facing === FACE_NORTH) return [[0, 0, 0, 1, 1, plate]];
      if (facing === FACE_SOUTH) return [[0, 0, 1 - plate, 1, 1, 1]];
      if (facing === FACE_WEST) return [[0, 0, 0, plate, 1, 1]];
      return [[1 - plate, 0, 0, 1, 1, 1]];
    }
    case MODEL_BED:
      return [[0, 0, 0, 1, 9 * S, 1]];
    case MODEL_ANVIL:
      return [[2 * S, 0, 2 * S, 14 * S, 1, 14 * S]];
    case MODEL_CHEST:
      return [[S, 0, S, 15 * S, 14 * S, 15 * S]];
    default:
      break;
  }

  const custom = CUSTOM_SHAPE[id];
  if (custom && def.collision !== 'none') return custom;
  if (def.boxes && def.boxes.length) return def.boxes;
  switch (def.collision) {
    case 'none': return NO_BOX;
    case 'half': return (m & 1) ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.5, 1]];
    case 'thin': return [[7 * S, 0, 0, 9 * S, 1, 1], [0, 0, 7 * S, 1, 1, 9 * S]];
    default: return FULL_BOX;
  }
}

/** Untranslated outline template; falls back to a visible shape for pass-through blocks. */
function selectionTemplate(id, meta) {
  const def = getBlock(id);
  const model = T_MODEL[id];
  const m = meta & 15;
  switch (model) {
    case MODEL_NONE:
      return def.name === 'barrier' ? FULL_BOX : NO_BOX;
    case MODEL_FLUID:
      return [[0, 0, 0, 1, fluidHeight(m), 1]];
    case MODEL_CROSS:
      return [[3 * S, 0, 3 * S, 13 * S, 13 * S, 13 * S]];
    case MODEL_CROP:
      return [[0, 0, 0, 1, 0.25 + 0.75 * ((m & 7) / 7), 1]];
    case MODEL_TORCH: {
      const mm = m & 7;
      if (mm === 0) return [[6 * S, 0, 6 * S, 10 * S, 10 * S, 10 * S]];
      const d = (mm - 1) & 3;
      const dx = HDX[d], dz = HDZ[d];
      const cx = 0.5 - dx * 0.25, cz = 0.5 - dz * 0.25;
      return [[cx - 3 * S, 3 * S, cz - 3 * S, cx + 3 * S, 13 * S, cz + 3 * S]];
    }
    case MODEL_FLAT: {
      if (def.boxes && def.boxes.length) return def.boxes;
      if (T_TINT[id] === 4 || def.name === 'tripwire') return [[0, 0, 0, 1, S, 1]];
      return [[S, 0, S, 15 * S, S, 15 * S]];
    }
    case MODEL_RAIL:
      return [[0, 0, 0, 1, 2 * S, 1]];
    case MODEL_LADDER: {
      const facing = m & 3, t = 2 * S;
      if (facing === 0) return [[0, 0, 1 - t, 1, 1, 1]];
      if (facing === 1) return [[0, 0, 0, t, 1, 1]];
      if (facing === 2) return [[0, 0, 0, 1, 1, t]];
      return [[1 - t, 0, 0, 1, 1, 1]];
    }
    case MODEL_VINE:
      return FULL_BOX;
    case MODEL_BUTTON: {
      wallMountBox(m & 7, 6 * S, 4 * S, 2 * S, _mb);
      return [[_mb[0], _mb[1], _mb[2], _mb[3], _mb[4], _mb[5]]];
    }
    case MODEL_LEVER: {
      wallMountBox(m & 7, 6 * S, 8 * S, 3 * S, _mb);
      return [[_mb[0], _mb[1], _mb[2], _mb[3], _mb[4], _mb[5]]];
    }
    case MODEL_SKULL: {
      const mm = m & 7;
      if (mm < 4) return [[4 * S, 0, 4 * S, 12 * S, 8 * S, 12 * S]];
      const d = (mm - 4) & 3;
      const cx = 0.5 - HDX[d] * 4 * S, cz = 0.5 - HDZ[d] * 4 * S;
      return [[cx - 4 * S, 4 * S, cz - 4 * S, cx + 4 * S, 12 * S, cz + 4 * S]];
    }
    case MODEL_POT:
      return [[5 * S, 0, 5 * S, 11 * S, 6 * S, 11 * S]];
    case MODEL_SIGN:
      return [[S, 0, 7 * S, 15 * S, 1, 9 * S]];
    case MODEL_WALL_SIGN: {
      const facing = m & 3, t = 2 * S;
      if (facing === 0) return [[0, 4 * S, 0, 1, 12 * S, t]];
      if (facing === 1) return [[1 - t, 4 * S, 0, 1, 12 * S, 1]];
      if (facing === 2) return [[0, 4 * S, 1 - t, 1, 12 * S, 1]];
      return [[0, 4 * S, 0, t, 12 * S, 1]];
    }
    case MODEL_FENCE:
    case MODEL_WALL:
    case MODEL_FENCE_GATE:
      return FULL_BOX;
    case MODEL_LAYER:
      return [[0, 0, 0, 1, ((m & 7) + 1) * 2 * S, 1]];
    case MODEL_CARPET:
      return [[0, 0, 0, 1, S, 1]];
    default:
      break;
  }
  const coll = collisionTemplate(id, meta);
  if (coll.length) return coll;
  return FULL_BOX;
}

function templateFor(cache, fn, id, meta) {
  const key = ((id & ID_MASK) << 4) | (meta & 15);
  let t = cache.get(key);
  if (t === undefined) {
    t = fn(id, meta);
    cache.set(key, t);
  }
  return t;
}

/**
 * World-space collision boxes for one block. Templates are cached per
 * (id, meta); the returned AABBs are fresh copies offset into the world.
 * @returns {AABB[]}
 */
export function blockBoxes(id, meta, x, y, z) {
  const t = templateFor(_collCache, collisionTemplate, id, meta);
  const n = t.length;
  if (n === 0) return NO_BOX;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = t[i];
    out[i] = new AABB(x + s[0], y + s[1], z + s[2], x + s[3], y + s[4], z + s[5]);
  }
  return out;
}

/**
 * World-space outline boxes for the block-highlight cursor. These follow the
 * rendered shape rather than the collision shape, so torches, plants, rails and
 * pressure plates get a sensible outline even though you walk through them.
 * @returns {AABB[]}
 */
export function selectionBoxes(id, meta, x, y, z) {
  const t = templateFor(_selCache, selectionTemplate, id, meta);
  const n = t.length;
  if (n === 0) return NO_BOX;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = t[i];
    out[i] = new AABB(x + s[0], y + s[1], z + s[2], x + s[3], y + s[4], z + s[5]);
  }
  return out;
}

/**
 * Drops every memoised table. Call after rebuilding the atlas or changing the
 * biome colour tables so the next mesh picks up the new values.
 */
export function resetMesherCaches() {
  _uvCache = new Array(65536);
  _nameUV = new Map();
  _collCache.clear();
  _selCache.clear();
  _grassValid = new Uint8Array(NBIOME * WORLD_HEIGHT);
  _foliageValid = new Uint8Array(NBIOME * WORLD_HEIGHT);
  _waterValid = new Uint8Array(NBIOME);
  _grassCache = new Float32Array(NBIOME * WORLD_HEIGHT * 3);
  _foliageCache = new Float32Array(NBIOME * WORLD_HEIGHT * 3);
  _waterCache = new Float32Array(NBIOME * 3);
  resetBuilders();
}
