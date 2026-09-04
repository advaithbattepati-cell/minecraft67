// ============================================================================
// worldgen.js - Terrain generation for all three dimensions (CONTRACT.md §5).
//
// Everything here is a pure function of (seed, x, y, z). Nothing depends on
// generation order, on which chunk was asked for first, or on Game.*.
//
// Overworld pipeline, per chunk:
//   1. climate grid     - continentalness / erosion / temperature / humidity /
//                         weirdness sampled on a 4-block grid, one column of
//                         padding on every side.
//   2. height spline    - continentalness picks a base level, erosion picks how
//                         much relief that level is allowed, peaks-and-valleys
//                         (derived from weirdness) carves valleys and raises
//                         ridges, ridged noise adds mountain spines.
//   3. 3x3 blur         - the grid heights are box-blurred before they are
//                         bilinearly resampled, so biome borders are slopes.
//   4. 3D density       - a perlin field added near the surface only, gated on
//                         erosion, produces cliffs, overhangs and arches.
//   5. surface rules    - per biome, driven by the biome's own surface/filler/
//                         underwater block names plus special cases (badlands
//                         banding, snow, ice, sandstone, podzol, mycelium).
//   6. noise caves      - cheese (big caverns), spaghetti (two ridged fields
//                         intersecting), noodle (thin deep worms).
//   7. carvers          - classic tunnel worms and ravines, generated once per
//                         *source* chunk and cached, then replayed into every
//                         target chunk they touch.
//   8. aquifers         - anything carved below the local water table becomes
//                         water; below y=8 it becomes lava.
// ============================================================================

import {
  WORLD_HEIGHT, SEA_LEVEL, CHUNK_AREA, ID_MASK, packBlock,
  DIM_OVERWORLD, DIM_NETHER, DIM_END, NETHER_ROOF,
} from '../core/constants.js';
import { clamp, lerp, smoothstep } from '../core/util.js';
import { RNG, Noise, hash3, hashString } from '../core/rng.js';
import { BLOCKS, blockByName } from './blocks.js';
import { getBiome, biomeByName, biomeAtClimate } from './biomes.js';

// ---------------------------------------------------------------------------
// Sibling modules resolved lazily. features.js and structures.js are written by
// other passes; worldgen must still produce terrain if either is unavailable.
// The imports are kicked off at module scope, so they have long since settled
// by the time a player has clicked through the menu into a world.
// ---------------------------------------------------------------------------
let _features = null;
let _structures = null;
(() => {
  const grab = (path, assign) => {
    try { import(path).then(assign).catch(() => { /* optional */ }); } catch { /* no dynamic import */ }
  };
  grab('./features.js', (m) => { _features = m; });
  grab('./structures.js', (m) => { _structures = m; });
})();

// ---------------------------------------------------------------------------
// Block ids. blocks.js is a pure registry, so resolving at module scope is safe.
// ---------------------------------------------------------------------------
const bid = (name, fallback = 0) => {
  const d = blockByName(name);
  return d ? d.id : fallback;
};

const STONE = bid('stone', 1);
const DEEPSLATE = bid('deepslate', STONE);
const TUFF = bid('tuff', STONE);
const GRANITE = bid('granite', STONE);
const DIORITE = bid('diorite', STONE);
const ANDESITE = bid('andesite', STONE);
const DIRT = bid('dirt', STONE);
const COARSE_DIRT = bid('coarse_dirt', DIRT);
const GRASS_BLOCK = bid('grass_block', DIRT);
const GRAVEL = bid('gravel', DIRT);
const SAND = bid('sand', DIRT);
const RED_SAND = bid('red_sand', SAND);
const SANDSTONE = bid('sandstone', STONE);
const RED_SANDSTONE = bid('red_sandstone', SANDSTONE);
const WATER = bid('water', 0);
const LAVA = bid('lava', 0);
const BEDROCK = bid('bedrock', STONE);
const ICE = bid('ice', 0);
const PACKED_ICE = bid('packed_ice', ICE);
const BLUE_ICE = bid('blue_ice', PACKED_ICE);
const SNOW_LAYER = bid('snow', 0);
const SNOW_BLOCK = bid('snow_block', STONE);
const MUD = bid('mud', DIRT);
const TERRACOTTA = bid('terracotta', STONE);

// Badlands band palette, in the order vanilla layers them.
const BAND_COLORS = [
  bid('terracotta', STONE),
  bid('orange_terracotta', STONE),
  bid('yellow_terracotta', STONE),
  bid('brown_terracotta', STONE),
  bid('red_terracotta', STONE),
  bid('light_gray_terracotta', STONE),
  bid('white_terracotta', STONE),
];

// Nether
const NETHERRACK = bid('netherrack', STONE);
const SOUL_SAND = bid('soul_sand', SAND);
const SOUL_SOIL = bid('soul_soil', DIRT);
const BASALT = bid('basalt', STONE);
const SMOOTH_BASALT = bid('smooth_basalt', BASALT);
const BLACKSTONE = bid('blackstone', STONE);
const MAGMA_BLOCK = bid('magma_block', STONE);
const GLOWSTONE = bid('glowstone', STONE);
const CRIMSON_NYLIUM = bid('crimson_nylium', NETHERRACK);
const WARPED_NYLIUM = bid('warped_nylium', NETHERRACK);
const NETHER_QUARTZ_ORE = bid('nether_quartz_ore', NETHERRACK);
const NETHER_GOLD_ORE = bid('nether_gold_ore', NETHERRACK);
const GILDED_BLACKSTONE = bid('gilded_blackstone', BLACKSTONE);
const BONE_BLOCK = bid('bone_block', STONE);

// End
const END_STONE = bid('end_stone', STONE);
const OBSIDIAN = bid('obsidian', STONE);
const CHORUS_PLANT = bid('chorus_plant', 0);
const CHORUS_FLOWER = bid('chorus_flower', 0);
const TORCH = bid('torch', 0);

// Packed values used constantly.
const V_AIR = 0;
const V_WATER = packBlock(WATER, 0);
const V_LAVA = packBlock(LAVA, 0);
const V_STONE = packBlock(STONE, 0);
const V_DEEPSLATE = packBlock(DEEPSLATE, 0);
const V_BEDROCK = packBlock(BEDROCK, 0);
const V_NETHERRACK = packBlock(NETHERRACK, 0);
const V_END_STONE = packBlock(END_STONE, 0);

/**
 * Lookup table of ids a carver is allowed to cut through: solid, light-blocking
 * terrain of ordinary hardness. Bedrock (hardness -1) and obsidian (50) survive,
 * as do fluids and every non-opaque decoration.
 */
const CARVABLE = new Uint8Array(4096);
for (const d of BLOCKS) {
  if (!d) continue;
  if (!d.solid || !d.opaque || d.liquid) continue;
  if (!(d.hardness >= 0) || d.hardness > 6) continue;
  CARVABLE[d.id] = 1;
}
CARVABLE[BEDROCK] = 0;

// ---------------------------------------------------------------------------
// Splines
// ---------------------------------------------------------------------------

/** Evaluates a piecewise-linear spline given as sorted [x, y] pairs. */
function spline(points, x) {
  const n = points.length;
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[n - 1][0]) return points[n - 1][1];
  let lo = 0;
  // Small tables; a linear scan beats a binary search here.
  while (lo < n - 2 && points[lo + 1][0] < x) lo++;
  const a = points[lo], b = points[lo + 1];
  const t = (x - a[0]) / (b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * t;
}

// Raw continent noise -> continentalness. The near-vertical run between -0.24
// and -0.21 is the coastline: only a sliver of the noise range lands inside the
// ocean/beach transition, which is what keeps beaches thin.
const CONTINENT_REMAP = [
  [-1.00, -1.00], [-0.60, -0.55], [-0.35, -0.30], [-0.24, -0.19], [-0.21, -0.05],
  [-0.10, 0.05], [0.15, 0.30], [0.55, 0.62], [1.00, 1.00],
];

// Continentalness -> base terrain level. The plateau around c = 0 is the coast:
// it is deliberately flat so beaches are wide instead of being a single cliff.
const CONTINENT_SPLINE = [
  [-1.00, 20], [-0.75, 27], [-0.55, 34], [-0.46, 41], [-0.32, 50],
  [-0.19, 59], [-0.12, 62], [-0.05, 65], [0.02, 66.5], [0.10, 68],
  [0.24, 71], [0.42, 75], [0.66, 81], [1.00, 89],
];

// Erosion -> how much vertical relief the column is allowed. Low erosion is
// young, sharp, mountainous terrain; high erosion is old and flat.
const EROSION_AMP_SPLINE = [
  [-1.00, 1.55], [-0.85, 1.42], [-0.70, 1.16], [-0.52, 0.90], [-0.34, 0.68],
  [-0.10, 0.46], [0.18, 0.30], [0.45, 0.19], [0.72, 0.11], [1.00, 0.06],
];

// Peaks-and-valleys -> signed offset, before amplitude scaling. Valleys are
// shallow and wide, peaks are tall and narrow, exactly like vanilla's spline.
const PV_SPLINE = [
  [-1.00, -0.34], [-0.72, -0.24], [-0.45, -0.14], [-0.20, -0.04],
  [0.05, 0.08], [0.30, 0.26], [0.55, 0.48], [0.78, 0.74], [1.00, 1.00],
];

const HEIGHT_GAIN = 27;      // blocks per unit of (pv * amplitude)
const RIVER_BED = 58.5;
const LAVA_LEVEL = 8;        // carved space at or below this floods with lava
const SNOW_LINE_BASE = 92;

// 3x3 blur kernel used to soften the coarse height grid.
const BLUR = [1, 2, 1, 2, 4, 2, 1, 2, 1];

// Categories a player is happy to wake up in.
const HOSPITABLE = new Set(['plains', 'forest', 'taiga', 'savanna', 'jungle', 'swamp']);

// ---------------------------------------------------------------------------
// Reusable scratch buffers. Chunk generation is single threaded and one chunk
// at a time, so module-level scratch keeps the hot path allocation free.
// ---------------------------------------------------------------------------
const COL = new Uint16Array(WORLD_HEIGHT);       // one column being built
const CARVED = new Uint8Array(WORLD_HEIGHT);     // was this cell cut out of rock?
const GRID = 5;                                  // 4-block cells across a chunk
const GRID_Y = (WORLD_HEIGHT >> 2) + 1;          // 33 samples, y = 0..128
const GRID_LEN = GRID * GRID * GRID_Y;
const G_DENSITY = new Float32Array(GRID_LEN);
const G_CHEESE = new Float32Array(GRID_LEN);
const G_SPAG1 = new Float32Array(GRID_LEN);
const G_SPAG2 = new Float32Array(GRID_LEN);
const G_NOODLE1 = new Float32Array(GRID_LEN);
const G_NOODLE2 = new Float32Array(GRID_LEN);
/** Lattice rows above this y are never used by the noodle-cave fields. */
const NOODLE_GY = 13;
const H_SMOOTH = new Float32Array(GRID * GRID);  // blurred heights, chunk corners
const AQUIFER = new Uint8Array(CHUNK_AREA);      // per-column water table height
const CARVE_LIMIT = new Uint8Array(CHUNK_AREA);  // highest y a carver may touch

/** Grid index for the 5 x 33 x 5 noise lattice. */
const gi3 = (gx, gy, gz) => (gy * GRID + gz) * GRID + gx;

/** Trilinear sample of a 4x4x4-cell noise lattice at local block coords. */
function trilerp(field, lx, y, lz) {
  const gx = lx >> 2, gz = lz >> 2, gy = y >> 2;
  const fx = (lx & 3) * 0.25, fz = (lz & 3) * 0.25, fy = (y & 3) * 0.25;
  const i000 = gi3(gx, gy, gz);
  const i100 = i000 + 1;
  const i010 = gi3(gx, gy + 1, gz);
  const i110 = i010 + 1;
  const i001 = gi3(gx, gy, gz + 1);
  const i101 = i001 + 1;
  const i011 = gi3(gx, gy + 1, gz + 1);
  const i111 = i011 + 1;
  const x00 = field[i000] + (field[i100] - field[i000]) * fx;
  const x10 = field[i010] + (field[i110] - field[i010]) * fx;
  const x01 = field[i001] + (field[i101] - field[i001]) * fx;
  const x11 = field[i011] + (field[i111] - field[i011]) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Bilinear blend of one field of four neighbouring lattice samples. */
function bil(a, b, c, d, key, fx, fz) {
  return lerp(lerp(a[key], b[key], fx), lerp(c[key], d[key], fx), fz);
}

/** Injective key for a signed grid coordinate pair (|gz| < 2^24). */
const gkey = (gx, gz) => gx * 33554432 + gz;

/** Deterministic float in [0,1) from a 3D coordinate and a salt. */
const rand3 = (seed, x, y, z) => hash3(seed, x, y, z) / 4294967296;

// ===========================================================================
// WorldGen
// ===========================================================================

/**
 * The terrain generator for one dimension of one world.
 * All public methods are deterministic in (seed, coordinates).
 */
export class WorldGen {
  /**
   * @param {number|string} seed world seed
   * @param {string} dimension 'overworld' | 'nether' | 'end'
   */
  constructor(seed, dimension = DIM_OVERWORLD) {
    this.seed = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) >>> 0;
    this.dimension = dimension || DIM_OVERWORLD;
    // Set false by the Create New World screen's "Generate Structures" toggle.
    this.generateStructures = true;

    const s = this.seed;
    const n = (k) => new Noise(hash3(s, k, 0x9e3779b9 | 0, 0x5bf03635 | 0));

    // --- overworld climate ---
    this.nCont = n(1);
    this.nEros = n(2);
    this.nTemp = n(3);
    this.nHumid = n(4);
    this.nWeird = n(5);
    this.nRidge = n(6);
    this.nDetail = n(7);
    this.nWarp = n(8);
    // --- overworld shape / caves ---
    this.nDensity = n(9);
    this.nCheese = n(10);
    this.nSpag1 = n(11);
    this.nSpag2 = n(12);
    this.nNoodle = n(13);
    this.nAquifer = n(14);
    this.nSurface = n(15);
    this.nStone = n(16);
    this.nBand = n(17);
    this.nJag = n(18);
    this.nBlob = n(19);
    // --- nether ---
    this.nNether = n(24);
    this.nNetherT = n(25);
    this.nNetherH = n(26);
    this.nDelta = n(27);
    this.nNetherSurf = n(28);
    // --- end ---
    this.nEnd = n(29);
    this.nEndDetail = n(30);
    this.nEndIsland = n(31);
    this.nEndUnder = n(32);

    // Badlands terracotta banding is a world-wide pattern, like vanilla's.
    this.bands = new Uint16Array(64);
    const brng = new RNG(hash3(s, 0xbad1, 0xa2d5, 0x0007));
    for (let i = 0; i < 64; i++) this.bands[i] = BAND_COLORS[0];
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < 64; i++) {
        if (!brng.chance(0.14)) continue;
        const color = BAND_COLORS[1 + brng.int(BAND_COLORS.length - 1)];
        const len = 1 + brng.int(3);
        for (let j = 0; j < len && i + j < 64; j++) this.bands[i + j] = color;
      }
    }

    // Caches. Keys are numeric so the Maps stay fast.
    this._cs = new Map();      // grid climate/height samples
    this._hs = new Map();      // blurred grid heights
    this._carve = new Map();   // per source chunk carver geometry
  }

  // -------------------------------------------------------------------------
  // Overworld climate + height field
  // -------------------------------------------------------------------------

  /**
   * Climate and raw height at one point of the 4-block sampling lattice.
   * Cached; the result object is shared and must be treated as read-only.
   */
  _sample(gx, gz) {
    const key = gkey(gx, gz);
    const hit = this._cs.get(key);
    if (hit !== undefined) return hit;

    const wx = gx * 4, wz = gz * 4;

    // A gentle domain warp keeps continent outlines from looking like fbm.
    const wpx = this.nWarp.simplex2(wx * 0.0016, wz * 0.0016) * 70;
    const wpz = this.nWarp.simplex2(wx * 0.0016 + 41.7, wz * 0.0016 - 19.3) * 70;
    const cx = wx + wpx, cz = wz + wpz;

    // Continentalness is remapped through a spline whose steep middle section
    // compresses the shoreline band: without it, the fixed coast window inside
    // biomeAtClimate() would turn about one column in eight into a beach.
    const c = spline(CONTINENT_REMAP,
      clamp(this.nCont.fbm2(cx * 0.00062, cz * 0.00062, 5, 2, 0.5) * 1.85, -1, 1));
    const e = clamp(this.nEros.fbm2(wx * 0.00092, wz * 0.00092, 4, 2, 0.5) * 1.85, -1, 1);
    const t = clamp(this.nTemp.fbm2(wx * 0.00042, wz * 0.00042, 3, 2, 0.5) * 1.65, -1, 1);
    const hu = clamp(this.nHumid.fbm2(wx * 0.00055, wz * 0.00055, 3, 2, 0.5) * 1.70, -1, 1);
    const w = clamp(this.nWeird.fbm2(wx * 0.00088, wz * 0.00088, 4, 2, 0.5) * 1.95, -1, 1);

    // Peaks and valleys: vanilla's folded weirdness. -1 in river bottoms,
    // +1 on ridge lines, 0 on the flanks.
    const pv = clamp(1 - Math.abs(3 * Math.abs(w) - 2), -1, 1);

    const biome = biomeAtClimate(t, hu, c, e, w);
    const b = getBiome(biome);

    // --- height spline -----------------------------------------------------
    let amp = spline(EROSION_AMP_SPLINE, e);
    let h = spline(CONTINENT_SPLINE, c);
    h += spline(PV_SPLINE, pv) * amp * HEIGHT_GAIN;

    // Ridged noise only bites where erosion left the terrain sharp; that is
    // what turns "tall" into "a mountain range" instead of "a big lump".
    const ridgeMask = clamp((amp - 0.62) / 0.55, 0, 1);
    if (ridgeMask > 0) {
      const r = this.nRidge.ridged2(wx * 0.0021, wz * 0.0021, 4, 2, 0.5);
      h += (r - 0.56) * 2 * ridgeMask * amp * 21;
    }

    // Surface roughness. Flat land stays flat, hills get bumpy.
    h += this.nDetail.fbm2(wx * 0.014, wz * 0.014, 3, 2, 0.5) * (1.1 + amp * 3.4);

    // Ocean floors get their own low-frequency relief so they are not a plane.
    if (c < -0.19) {
      h += this.nDetail.fbm2(wx * 0.004 + 90, wz * 0.004 - 12, 3, 2, 0.5) * 6;
    }

    // Rivers: the near-zero contour of the weirdness field, cut into the land.
    // biomeAtClimate() calls |w| < 0.055 a river, so the carve has to be at
    // full strength well before that, or the biome shows up on dry land.
    const aw = Math.abs(w);
    if (aw < 0.13 && c > -0.19) {
      const k = smoothstep(clamp((0.13 - aw) / 0.055, 0, 1))
        * clamp(1.05 - amp * 0.22, 0.55, 1);
      const bed = RIVER_BED - 3.2 + (1 - k) * 7;
      if (h > bed) h = lerp(h, bed, k);
    }

    // Nudge toward the biome's declared band so plateaus, oceans and peaks
    // read like themselves. The 3x3 blur below turns the seams into slopes.
    const band = clamp(h, b.minHeight - 3, b.maxHeight + 3);
    h = h * 0.74 + band * 0.26;

    // Mushroom fields are the one land biome that lives inside ocean
    // continentalness. Without a lift they would generate as a drowned shelf,
    // so the island is raised here; the 3x3 blur turns the step into a cliff.
    if (biome === MUSHROOM_ISLAND) {
      const lift = 69 + this.nDetail.fbm2(wx * 0.019 + 311, wz * 0.019 - 47, 3, 2, 0.5) * 6;
      if (h < lift) h = lift;
    }

    h = clamp(h, 3, WORLD_HEIGHT - 5);

    // Jaggedness gates the 3D density term: only unweathered rock overhangs.
    let jag = clamp((-e - 0.22) / 0.66, 0, 1);
    jag *= clamp(this.nJag.simplex2(wx * 0.0035, wz * 0.0035) * 1.6 + 0.55, 0, 1);
    if (b.category === 'desert' && b.filler === 'terracotta') jag = Math.max(jag, 0.45);
    if (c < -0.19) jag *= 0.25;

    const out = { c, e, t, h: hu, w, pv, amp, jag, y: h, biome };
    if (this._cs.size > 26000) this._cs.clear();
    this._cs.set(key, out);
    return out;
  }

  /** 3x3 box-blurred lattice height. This is what the world actually uses. */
  _gridHeight(gx, gz) {
    const key = gkey(gx, gz);
    const hit = this._hs.get(key);
    if (hit !== undefined) return hit;
    let sum = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        sum += this._sample(gx + dx, gz + dz).y * BLUR[(dz + 1) * 3 + dx + 1];
      }
    }
    const v = sum / 16;
    if (this._hs.size > 26000) this._hs.clear();
    this._hs.set(key, v);
    return v;
  }

  /** Continuous overworld surface height at any world column. */
  _terrainHeight(x, z) {
    const gx = Math.floor(x / 4), gz = Math.floor(z / 4);
    const fx = (x - gx * 4) / 4, fz = (z - gz * 4) / 4;
    const h00 = this._gridHeight(gx, gz);
    const h10 = this._gridHeight(gx + 1, gz);
    const h01 = this._gridHeight(gx, gz + 1);
    const h11 = this._gridHeight(gx + 1, gz + 1);
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  }

  /** Bilinearly resampled climate, so biome edges follow the same curves. */
  _columnBiome(x, z) {
    const gx = Math.floor(x / 4), gz = Math.floor(z / 4);
    const fx = (x - gx * 4) / 4, fz = (z - gz * 4) / 4;
    const a = this._sample(gx, gz), b = this._sample(gx + 1, gz);
    const c = this._sample(gx, gz + 1), d = this._sample(gx + 1, gz + 1);
    return biomeAtClimate(bil(a, b, c, d, 't', fx, fz), bil(a, b, c, d, 'h', fx, fz),
      bil(a, b, c, d, 'c', fx, fz), bil(a, b, c, d, 'e', fx, fz),
      bil(a, b, c, d, 'w', fx, fz));
  }

  /** Local water table for cave aquifers, or -1 when the region is dry. */
  _aquiferLevel(x, z) {
    const a = this.nAquifer.fbm2(x * 0.0035, z * 0.0035, 2, 2, 0.5);
    if (a < 0.06) return -1;
    return Math.round(clamp(20 + a * 26, 18, 34));
  }

  /** Fills the 4x4x4-cell density and cheese-cave lattices for one chunk. */
  _fillLattices(ox, oz) {
    const dn = this.nDensity, cn = this.nCheese, s1 = this.nSpag1, s2 = this.nSpag2;
    const nd = this.nNoodle;
    for (let gy = 0; gy < GRID_Y; gy++) {
      const wy = gy * 4;
      for (let gz = 0; gz < GRID; gz++) {
        const wz = oz + gz * 4;
        for (let gx = 0; gx < GRID; gx++) {
          const wx = ox + gx * 4;
          const i = gi3(gx, gy, gz);
          G_DENSITY[i] = dn.fbm3(wx * 0.0165, wy * 0.031, wz * 0.0165, 2, 2, 0.5);
          G_CHEESE[i] = cn.fbm3(wx * 0.0082, wy * 0.0175, wz * 0.0082, 3, 2, 0.5) * 2.25;
          // The spaghetti fields have a ~70 block period, so sampling them on
          // the same 4-block lattice costs 20x less than per block and the
          // interpolation error near their zero crossings is negligible.
          G_SPAG1[i] = s1.perlin3(wx * 0.0145, wy * 0.029, wz * 0.0145);
          G_SPAG2[i] = s2.perlin3(wx * 0.0138, wy * 0.027, wz * 0.0138);
          if (gy < NOODLE_GY) {
            G_NOODLE1[i] = nd.perlin3(wx * 0.031, wy * 0.030, wz * 0.031);
            G_NOODLE2[i] = s1.perlin3(wx * 0.034 + 61.3, wy * 0.033 - 17.7, wz * 0.034 + 8.9);
          }
        }
      }
    }
  }

  /** Cheese-cave threshold: huge caverns deep down, almost none near the sky. */
  _cheeseCut(y) {
    if (y <= 34) return 0.70;
    if (y >= 72) return 9;
    return 0.70 + (y - 34) * 0.045;
  }

  /** Depth at which a column turns from stone to deepslate. */
  _deepslateY(wx, wz) {
    return 11 + this.nStone.simplex2(wx * 0.055, wz * 0.055) * 3;
  }

  /**
   * Sparse granite / diorite / andesite / tuff blobs. Sampled once per two
   * vertical blocks: the blobs are ten blocks across, so the reuse is invisible
   * and it halves the cost of the single hottest call in the generator.
   */
  _blobStone(wx, y, wz) {
    const b = this.nBlob.perlin3(wx * 0.105, y * 0.105, wz * 0.105);
    if (b > 0.52) return packBlock(GRANITE, 0);
    if (b < -0.52) return packBlock(DIORITE, 0);
    const b2 = this.nBlob.perlin3(wx * 0.096 + 61.3, y * 0.1 - 23.7, wz * 0.096 + 17.1);
    if (b2 > 0.52) return packBlock(ANDESITE, 0);
    if (y < 26 && b2 < -0.54) return packBlock(TUFF, 0);
    return V_STONE;
  }

  // -------------------------------------------------------------------------
  // Overworld chunk
  // -------------------------------------------------------------------------

  /** @private Builds one overworld chunk into chunk.blocks. */
  _genOverworld(chunk) {
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;
    blocks.fill(0);
    this._fillLattices(ox, oz);

    // Blurred lattice heights for the 5 x 5 corners of this chunk.
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        H_SMOOTH[gz * GRID + gx] = this._gridHeight((chunk.cx * 4) + gx, (chunk.cz * 4) + gz);
      }
    }

    const seed = this.seed;
    const agx = chunk.cx * 4, agz = chunk.cz * 4;
    for (let lz = 0; lz < 16; lz++) {
      const wz = oz + lz;
      const gz = lz >> 2, fz = (lz & 3) * 0.25;
      for (let lx = 0; lx < 16; lx++) {
        const wx = ox + lx;
        const gx = lx >> 2, fx = (lx & 3) * 0.25;
        const ci = (lz << 4) | lx;

        // --- height + climate for this column ---------------------------
        const r0 = H_SMOOTH[gz * GRID + gx];
        const r1 = H_SMOOTH[gz * GRID + gx + 1];
        const r2 = H_SMOOTH[(gz + 1) * GRID + gx];
        const r3 = H_SMOOTH[(gz + 1) * GRID + gx + 1];
        const h = lerp(lerp(r0, r1, fx), lerp(r2, r3, fx), fz);

        // Climate and jaggedness share the four corner samples of this cell.
        const q0 = this._sample(agx + gx, agz + gz);
        const q1 = this._sample(agx + gx + 1, agz + gz);
        const q2 = this._sample(agx + gx, agz + gz + 1);
        const q3 = this._sample(agx + gx + 1, agz + gz + 1);
        const biomeId = biomeAtClimate(
          bil(q0, q1, q2, q3, 't', fx, fz), bil(q0, q1, q2, q3, 'h', fx, fz),
          bil(q0, q1, q2, q3, 'c', fx, fz), bil(q0, q1, q2, q3, 'e', fx, fz),
          bil(q0, q1, q2, q3, 'w', fx, fz));
        chunk.biomes[ci] = biomeId;
        const biome = getBiome(biomeId);
        const jag = bil(q0, q1, q2, q3, 'jag', fx, fz);

        // --- solid / air, with the 3D density term near the surface -------
        const top = Math.min(WORLD_HEIGHT - 2, Math.floor(h) + (jag > 0.05 ? 14 : 1));
        COL.fill(0);
        CARVED.fill(0);
        const dsY = this._deepslateY(wx, wz);
        let blobKey = -99, blobVal = V_STONE;
        let highest = 0;
        for (let y = 0; y <= top; y++) {
          let d = (h - y) * 0.118;
          if (jag > 0.03) {
            const near = 1 - Math.min(1, Math.abs(h - y) / 20);
            if (near > 0) d += trilerp(G_DENSITY, lx, y, lz) * 1.75 * jag * near * near;
          }
          if (y < 6) d += (6 - y) * 0.6;                       // squash to solid
          if (y > 116) d -= (y - 116) * 0.09;                  // squash to air
          if (d <= 0) continue;
          highest = y;
          if (y < dsY - 1) { COL[y] = V_DEEPSLATE; continue; }
          if (y < dsY + 1.5) {
            COL[y] = rand3(this.seed ^ 0x7c15, wx, y, wz) < 0.45 ? V_DEEPSLATE : V_STONE;
            continue;
          }
          const k = y >> 1;
          if (k !== blobKey) { blobKey = k; blobVal = this._blobStone(wx, k << 1, wz); }
          COL[y] = blobVal;
        }

        // --- noise caves --------------------------------------------------
        const aq = this._aquiferLevel(wx, wz);
        AQUIFER[ci] = aq < 0 ? 0 : aq;
        const caveTop = Math.min(highest, WORLD_HEIGHT - 3);
        for (let y = 2; y <= caveTop; y++) {
          if (!CARVABLE[COL[y] & ID_MASK]) continue;
          let cut = false;
          if (trilerp(G_CHEESE, lx, y, lz) > this._cheeseCut(y)) {
            cut = true;
          } else if (y < highest - 3) {
            // Spaghetti: two thin noise sheets; their intersection is a tube.
            if (Math.abs(trilerp(G_SPAG1, lx, y, lz)) < 0.042
                && Math.abs(trilerp(G_SPAG2, lx, y, lz)) < 0.042) {
              cut = true;
            }
            // Noodle: the same trick at a higher frequency, deep down only.
            if (!cut && y > 6 && y < 46
                && Math.abs(trilerp(G_NOODLE1, lx, y, lz)) < 0.032
                && Math.abs(trilerp(G_NOODLE2, lx, y, lz)) < 0.032) {
              cut = true;
            }
          }
          if (!cut) continue;
          COL[y] = y <= LAVA_LEVEL ? V_LAVA : (aq >= 0 && y <= aq ? V_WATER : V_AIR);
          CARVED[y] = 1;
        }

        // --- ocean / lake water: any never-solid cell below sea level ------
        for (let y = SEA_LEVEL; y >= 1; y--) {
          if (COL[y] === V_AIR && !CARVED[y]) COL[y] = V_WATER;
        }

        // --- bedrock ------------------------------------------------------
        COL[0] = V_BEDROCK;
        for (let y = 1; y <= 4; y++) {
          if (rand3(seed ^ 0xbed70c, wx, y, wz) < (5 - y) / 5) COL[y] = V_BEDROCK;
        }

        // --- surface rules -------------------------------------------------
        this._surfaceColumn(wx, wz, biome, h);

        // --- commit --------------------------------------------------------
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const v = COL[y];
          if (v !== 0) blocks[(y << 8) | ci] = v;
        }
      }
    }

    this._carveChunk(chunk);
  }

  /**
   * Applies the biome surface rules to the scratch column. Only runs whose top
   * sits near the height field are treated as "ground"; deeper runs exposed by
   * cave carving stay bare stone, the way vanilla leaves them.
   */
  _surfaceColumn(wx, wz, biome, h) {
    const s = surfaceOf(biome);
    const rough = this.nSurface.simplex2(wx * 0.085, wz * 0.085);
    const depthMax = 3 + Math.round(rough * 1.7);        // 1..5 blocks of soil
    const bandOff = Math.round(this.nBand.simplex2(wx * 0.055, wz * 0.055) * 4.5);
    const snowLine = SNOW_LINE_BASE + biome.temperature * 14;

    let depth = -1;
    let run = -1;
    let submerged = false;
    let live = false;

    // Nothing this far under the height field can still be part of a run whose
    // top counts as ground, so the scan stops there instead of at bedrock.
    const floor = Math.max(1, Math.floor(h) - 22);
    for (let y = WORLD_HEIGHT - 2; y >= floor; y--) {
      const id = COL[y] & ID_MASK;
      if (id === 0 || id === WATER || id === LAVA || !CARVABLE[id]) { depth = -1; continue; }

      if (depth < 0) {
        depth = 0;
        run++;
        live = run === 0 || y >= h - 8;
        if (!live) continue;
        submerged = (COL[y + 1] & ID_MASK) === WATER;

        if (s.badlands) {
          COL[y] = packBlock(y >= 64 ? (s.wooded && y > 80 ? COARSE_DIRT : RED_SAND)
            : this.bands[(y + bandOff) & 63], 0);
        } else if (submerged) {
          COL[y] = packBlock(y < SEA_LEVEL - 7 ? s.deepUnder : s.under, 0);
        } else {
          COL[y] = packBlock(s.top, 0);
          const layers = y > snowLine ? Math.min(3, Math.floor((y - snowLine) / 7)) : 0;
          if ((s.snowy || y > snowLine) && s.snowable && COL[y + 1] === 0 && y + 1 < WORLD_HEIGHT - 1) {
            COL[y + 1] = packBlock(SNOW_LAYER, layers);
          }
        }
        continue;
      }

      depth++;
      if (!live) continue;

      if (s.badlands) {
        if (y >= 64 && depth <= 2) COL[y] = packBlock(RED_SAND, 0);
        else if (depth <= 22 && y > 52) COL[y] = packBlock(this.bands[(y + bandOff) & 63], 0);
        continue;
      }
      if (depth <= depthMax) {
        COL[y] = packBlock(s.filler, 0);
      } else if (depth <= depthMax + 3 && s.deep !== STONE) {
        COL[y] = packBlock(s.deep, 0);
      }
      // Deeper than that the column is already the right stone.
    }

    // Frozen surfaces: a skin of ice on standing water, thicker in deep cold.
    if (s.frozen && (COL[SEA_LEVEL] & ID_MASK) === WATER && (COL[SEA_LEVEL + 1] & ID_MASK) === 0) {
      const r = rand3(this.seed ^ 0x1ce1ce, wx, 0, wz);
      COL[SEA_LEVEL] = packBlock(s.deepFreeze && r < 0.09 ? (r < 0.02 ? BLUE_ICE : PACKED_ICE) : ICE, 0);
    }
  }

  // -------------------------------------------------------------------------
  // Carvers: tunnels and ravines
  // -------------------------------------------------------------------------

  /**
   * Carver geometry produced by one source chunk, as a flat Float32Array with
   * stride 6: [x, y, z, horizontal radius, vertical radius, ravineId].
   * Computed once per source chunk and replayed into every chunk it reaches.
   */
  _carverGeometry(ccx, ccz) {
    const key = gkey(ccx, ccz);
    const hit = this._carve.get(key);
    if (hit !== undefined) return hit;

    const rng = new RNG(hash3(this.seed ^ 0x1f2e3d4c, ccx, ccz, 0x63a5));
    const out = [];

    // Ravines are rare and always deep.
    if (rng.next() < 0.019) {
      const rx = (ccx << 4) + rng.int(16);
      const ry = 12 + rng.int(rng.int(58) + 8);
      const rz = (ccz << 4) + rng.int(16);
      this._walkRavine(out, rng, rx, ry, rz);
    }

    // Vanilla's nested-int distribution: usually zero, occasionally a knot.
    const tries = rng.int(rng.int(rng.int(11) + 1) + 1);
    for (let i = 0; i < tries; i++) {
      const x = (ccx << 4) + rng.int(16);
      const y = 9 + rng.int(rng.int(96) + 12);
      const z = (ccz << 4) + rng.int(16);
      let count = 1;
      if (rng.next() < 0.22) {
        // A "room": one big spherical cavern where the system starts.
        out.push(x, y, z, 1.8 + rng.next() * 3.4, 1.6 + rng.next() * 2.2, 0);
        count += rng.int(4);
      }
      for (let j = 0; j < count; j++) {
        const yaw = rng.next() * Math.PI * 2;
        const pitch = (rng.next() - 0.5) * 0.28;
        let width = rng.next() * 1.3 + 0.6;
        if (rng.next() < 0.08) width *= rng.next() * 2.2 + 1;
        this._walkTunnel(out, new RNG(hash3(rng.state, i, j, 0x7a11)),
          x, y, z, width, yaw, pitch, 0, 0, 1.0, 0);
      }
    }

    const arr = out.length ? Float32Array.from(out) : EMPTY_CARVE;
    if (this._carve.size > 1400) this._carve.clear();
    this._carve.set(key, arr);
    return arr;
  }

  /** Random-walks one cave tunnel, appending carve records. */
  _walkTunnel(out, rng, x, y, z, width, yaw, pitch, step, maxSteps, yScale, depth) {
    let yawChange = 0, pitchChange = 0;
    if (maxSteps <= 0) maxSteps = 40 + rng.int(34);
    const branchAt = maxSteps / 4 + rng.int(Math.max(1, maxSteps >> 1));
    const steep = rng.int(6) === 0;

    for (; step < maxSteps; step++) {
      const hr = 1.05 + Math.sin((step * Math.PI) / maxSteps) * width;
      const vr = hr * yScale;
      const cosP = Math.cos(pitch);
      x += Math.cos(yaw) * cosP;
      y += Math.sin(pitch);
      z += Math.sin(yaw) * cosP;
      pitch *= steep ? 0.92 : 0.7;
      pitch += pitchChange * 0.1;
      yaw += yawChange * 0.2;
      pitchChange = pitchChange * 0.75 + (rng.next() - rng.next()) * rng.next() * 2;
      yawChange = yawChange * 0.9 + (rng.next() - rng.next()) * rng.next() * 4;

      if (y < 6 || y > WORLD_HEIGHT - 10) return;

      if (step === (branchAt | 0) && width > 1.2 && depth < 2) {
        this._walkTunnel(out, rng, x, y, z, rng.next() * 0.5 + 0.5,
          yaw - Math.PI / 2, pitch / 3, step, maxSteps, 1.0, depth + 1);
        this._walkTunnel(out, rng, x, y, z, rng.next() * 0.5 + 0.5,
          yaw + Math.PI / 2, pitch / 3, step, maxSteps, 1.0, depth + 1);
        return;
      }
      if (rng.int(4) === 0) continue;
      out.push(x, y, z, hr, vr, 0);
    }
  }

  /** Random-walks one ravine: long, thin, and very tall. */
  _walkRavine(out, rng, x, y, z) {
    const rid = (hash3(this.seed, x, y, z) | 1) >>> 0;
    const maxSteps = 60 + rng.int(50);
    let yaw = rng.next() * Math.PI * 2;
    let pitch = (rng.next() - 0.5) * 0.22;
    const width = 2.2 + rng.next() * 2.6;
    let yawChange = 0, pitchChange = 0;

    for (let step = 0; step < maxSteps; step++) {
      const hr = 1.0 + Math.sin((step * Math.PI) / maxSteps) * width;
      const vr = hr * 3.2;
      const cosP = Math.cos(pitch);
      x += Math.cos(yaw) * cosP;
      y += Math.sin(pitch) * 0.7;
      z += Math.sin(yaw) * cosP;
      pitch = pitch * 0.7 + pitchChange * 0.05;
      yaw += yawChange * 0.15;
      pitchChange = pitchChange * 0.8 + (rng.next() - rng.next()) * rng.next() * 2;
      yawChange = yawChange * 0.5 + (rng.next() - rng.next()) * rng.next() * 4;
      if (y < 10 || y > 96) return;
      if (rng.int(4) === 0) continue;
      out.push(x, y, z, hr, vr, rid);
    }
  }

  /** Replays every nearby source chunk's carver geometry into this chunk. */
  _carveChunk(chunk) {
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;

    // A carver may never drain an ocean: cap it below the water it would open.
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const ci = (lz << 4) | lx;
        let limit = WORLD_HEIGHT - 2;
        if ((blocks[(SEA_LEVEL << 8) | ci] & ID_MASK) === WATER) {
          let y = SEA_LEVEL;
          while (y > 0 && (blocks[(y << 8) | ci] & ID_MASK) === WATER) y--;
          limit = Math.max(0, y - 2);
        }
        CARVE_LIMIT[ci] = limit;
      }
    }

    const cxMid = ox + 8, czMid = oz + 8;
    for (let dz = -CARVE_RADIUS; dz <= CARVE_RADIUS; dz++) {
      for (let dx = -CARVE_RADIUS; dx <= CARVE_RADIUS; dx++) {
        const geo = this._carverGeometry(chunk.cx + dx, chunk.cz + dz);
        for (let i = 0; i < geo.length; i += 6) {
          const x = geo[i], y = geo[i + 1], z = geo[i + 2];
          const hr = geo[i + 3], vr = geo[i + 4], rid = geo[i + 5];
          // Cheap rejection before the per-block loop.
          const ddx = x - cxMid, ddz = z - czMid;
          const reach = hr * 1.6 + 12;
          if (ddx * ddx + ddz * ddz > reach * reach) continue;
          this._carveSphere(chunk, x, y, z, hr, vr, rid);
        }
      }
    }
  }

  /** Cuts one ellipsoid out of a chunk, honouring aquifers and the sea floor. */
  _carveSphere(chunk, x, y, z, hr, vr, rid) {
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;
    let x0 = Math.floor(x - hr) - ox, x1 = Math.ceil(x + hr) - ox;
    let z0 = Math.floor(z - hr) - oz, z1 = Math.ceil(z + hr) - oz;
    if (x0 < 0) x0 = 0; if (x1 > 15) x1 = 15;
    if (z0 < 0) z0 = 0; if (z1 > 15) z1 = 15;
    if (x0 > x1 || z0 > z1) return;
    let y0 = Math.floor(y - vr), y1 = Math.ceil(y + vr);
    if (y0 < 1) y0 = 1; if (y1 > WORLD_HEIGHT - 2) y1 = WORLD_HEIGHT - 2;

    for (let yy = y0; yy <= y1; yy++) {
      const dy = (yy + 0.5 - y) / vr;
      const dy2 = dy * dy;
      if (dy2 >= 1) continue;
      // Ravines get a jagged, per-layer width so the walls are not smooth.
      const scale = rid ? 0.68 + (hash3(rid, yy >> 1, 0x5a17, 0) / 4294967296) * 0.8 : 1;
      const rh = hr * scale;
      const inv = 1 / (rh * rh);
      for (let lz = z0; lz <= z1; lz++) {
        const dz = oz + lz + 0.5 - z;
        const dz2 = dz * dz * inv;
        if (dz2 + dy2 >= 1) continue;
        const ci = (lz << 4);
        for (let lx = x0; lx <= x1; lx++) {
          const idx = ci | lx;
          if (yy > CARVE_LIMIT[idx]) continue;
          const dx = ox + lx + 0.5 - x;
          if (dx * dx * inv + dz2 + dy2 >= 1) continue;
          const bi = (yy << 8) | idx;
          const id = blocks[bi] & ID_MASK;
          if (!CARVABLE[id]) continue;
          const aq = AQUIFER[idx];
          blocks[bi] = yy <= LAVA_LEVEL ? V_LAVA : (aq > 0 && yy <= aq ? V_WATER : V_AIR);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Nether
  // -------------------------------------------------------------------------

  /** Nether biome id for a column. */
  _netherBiome(wx, wz) {
    const t = this.nNetherT.fbm2(wx * 0.0034, wz * 0.0034, 3, 2, 0.5) * 1.9;
    const h = this.nNetherH.fbm2(wx * 0.0031 + 51, wz * 0.0031 - 27, 3, 2, 0.5) * 1.9;
    if (t < -0.42) return NB.soul_sand_valley;
    if (h > 0.42) return NB.warped_forest;
    if (h < -0.42) return NB.crimson_forest;
    if (t > 0.55 && h > -0.15 && h < 0.15) return NB.basalt_deltas;
    return NB.nether_wastes;
  }

  /** Solidity field for the netherrack sea. Positive is rock. */
  _netherDensity(wx, y, wz) {
    return this.nNether.fbm3(wx * 0.0265, y * 0.05, wz * 0.0265, 4, 2, 0.5) * 2.6
      + netherBias(y);
  }

  /** @private Builds one nether chunk. */
  _genNether(chunk) {
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;
    blocks.fill(0);

    // Density lattice, same 4-block cells as the overworld.
    for (let gy = 0; gy < GRID_Y; gy++) {
      const wy = gy * 4;
      for (let gz = 0; gz < GRID; gz++) {
        for (let gx = 0; gx < GRID; gx++) {
          G_DENSITY[gi3(gx, gy, gz)] =
            this.nNether.fbm3((ox + gx * 4) * 0.0265, wy * 0.05, (oz + gz * 4) * 0.0265, 4, 2, 0.5) * 2.6;
        }
      }
    }

    const seed = this.seed;
    const roofBase = NETHER_ROOF;   // 120
    for (let lz = 0; lz < 16; lz++) {
      const wz = oz + lz;
      for (let lx = 0; lx < 16; lx++) {
        const wx = ox + lx;
        const ci = (lz << 4) | lx;
        const bId = this._netherBiome(wx, wz);
        chunk.biomes[ci] = bId;
        const delta = bId === NB.basalt_deltas;
        const soul = bId === NB.soul_sand_valley;
        COL.fill(0);

        for (let y = 1; y < WORLD_HEIGHT; y++) {
          if (y >= roofBase) {
            // Ragged bedrock underside over a solid cap; no holes to the void.
            COL[y] = (y >= roofBase + 4 || rand3(seed ^ 0x0f00, wx, y, wz) < (y - roofBase + 1) / 5)
              ? V_BEDROCK : V_NETHERRACK;
            continue;
          }
          if (trilerp(G_DENSITY, lx, y, lz) + netherBias(y) > NETHER_SOLID) COL[y] = V_NETHERRACK;
        }
        COL[0] = V_BEDROCK;
        for (let y = 1; y <= 4; y++) {
          if (rand3(seed ^ 0xbed70c, wx, y, wz) < (5 - y) / 5) COL[y] = V_BEDROCK;
        }

        // Lava ocean.
        for (let y = 5; y <= 31; y++) if (COL[y] === V_AIR) COL[y] = V_LAVA;

        this._netherSurface(wx, wz, bId, delta, soul);

        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          if (COL[y] !== 0) blocks[(y << 8) | ci] = COL[y];
        }
      }
    }

    this._netherDecor(chunk);
  }

  /** Nylium / soul sand / basalt skins plus magma under the lava sea. */
  _netherSurface(wx, wz, bId, delta, soul) {
    const jitter = this.nNetherSurf.simplex2(wx * 0.12, wz * 0.12);
    let top = NETHERRACK, fill = NETHERRACK, depth = 3;
    if (soul) { top = SOUL_SAND; fill = SOUL_SOIL; depth = 4 + Math.round(jitter * 2); }
    else if (bId === NB.crimson_forest) { top = CRIMSON_NYLIUM; fill = NETHERRACK; depth = 1; }
    else if (bId === NB.warped_forest) { top = WARPED_NYLIUM; fill = NETHERRACK; depth = 1; }
    else if (delta) { top = BASALT; fill = BLACKSTONE; depth = 3 + Math.round(jitter * 2); }

    let run = -1;
    let d = -1;
    for (let y = WORLD_HEIGHT - 2; y >= 5; y--) {
      const id = COL[y] & ID_MASK;
      if (id !== NETHERRACK) {
        if (id === LAVA && (COL[y - 1] & ID_MASK) === NETHERRACK
            && rand3(this.seed ^ 0x3a90, wx, y, wz) < 0.22) {
          COL[y - 1] = packBlock(MAGMA_BLOCK, 0);
        }
        d = -1;
        continue;
      }
      if (d < 0) {
        d = 0;
        run++;
        const above = COL[y + 1] & ID_MASK;
        if (above === 0) COL[y] = packBlock(top, 0);
        else if (above === LAVA) COL[y] = packBlock(delta ? BLACKSTONE : MAGMA_BLOCK, 0);
        continue;
      }
      d++;
      if (d <= depth) COL[y] = packBlock(fill, 0);
      // Ceilings: soul soil / blackstone rinds hanging from the roof of a run.
      if ((COL[y - 1] & ID_MASK) === 0 && (soul || delta)) {
        COL[y] = packBlock(soul ? SOUL_SOIL : BLACKSTONE, 0);
      }
    }
  }

  /** Ores, glowstone clusters, basalt columns and bone fossils. */
  _netherDecor(chunk) {
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;
    const rng = new RNG(hash3(this.seed ^ 0x4e37, chunk.cx, chunk.cz, 0x11));
    const put = (lx, y, lz, v) => {
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 1 || y >= WORLD_HEIGHT) return;
      const bi = (y << 8) | (lz << 4) | lx;
      if ((blocks[bi] & ID_MASK) === NETHERRACK) blocks[bi] = v;
    };
    const blob = (v, count, size, yMin, yMax) => {
      for (let i = 0; i < count; i++) {
        const cx = rng.int(16), cz = rng.int(16);
        const cy = yMin + rng.int(Math.max(1, yMax - yMin));
        const n = 2 + rng.int(size);
        for (let j = 0; j < n; j++) {
          put(cx + rng.int(3) - 1, cy + rng.int(3) - 1, cz + rng.int(3) - 1, v);
        }
      }
    };
    blob(packBlock(NETHER_QUARTZ_ORE, 0), 14, 8, 10, 114);
    blob(packBlock(NETHER_GOLD_ORE, 0), 9, 6, 10, 114);
    if (rng.chance(0.3)) blob(packBlock(GILDED_BLACKSTONE, 0), 1, 3, 8, 60);

    // Glowstone hangs from ceilings; bone fossils sit in soul sand valleys.
    for (let i = 0; i < 48; i++) {
      const lx = rng.int(16), lz = rng.int(16);
      const ci = (lz << 4) | lx;
      const y = 34 + rng.int(78);
      if ((blocks[(y << 8) | ci] & ID_MASK) !== 0) continue;
      if ((blocks[((y + 1) << 8) | ci] & ID_MASK) === 0) continue;
      // A blob hanging off the ceiling rather than a single block.
      const glow = packBlock(GLOWSTONE, 0);
      const n = 4 + rng.int(6);
      for (let k = 0; k < n; k++) {
        const gx = lx + rng.int(3) - 1, gz = lz + rng.int(3) - 1;
        const gy = y - rng.int(3);
        if (gx < 0 || gx > 15 || gz < 0 || gz > 15 || gy < 5) continue;
        const bi = (gy << 8) | (gz << 4) | gx;
        if ((blocks[bi] & ID_MASK) === 0) blocks[bi] = glow;
      }
    }

    // Basalt columns and blackstone rubble in the deltas.
    for (let i = 0; i < 26; i++) {
      const lx = rng.int(16), lz = rng.int(16);
      const ci = (lz << 4) | lx;
      if (chunk.biomes[ci] !== NB.basalt_deltas) continue;
      let y = 32;
      while (y < 110 && (blocks[(y << 8) | ci] & ID_MASK) !== 0) y++;
      if (y >= 110) continue;
      if ((blocks[((y - 1) << 8) | ci] & ID_MASK) === 0) continue;
      const tall = 2 + rng.int(8);
      for (let k = 0; k < tall && y + k < 116; k++) {
        if ((blocks[((y + k) << 8) | ci] & ID_MASK) !== 0) break;
        blocks[((y + k) << 8) | ci] = packBlock(k === tall - 1 && rng.chance(0.3) ? SMOOTH_BASALT : BASALT, 0);
      }
    }

    // Bone structures poking out of soul sand.
    for (let i = 0; i < 3; i++) {
      const lx = rng.int(16), lz = rng.int(16);
      const ci = (lz << 4) | lx;
      if (chunk.biomes[ci] !== NB.soul_sand_valley) continue;
      let y = 32;
      while (y < 110 && (blocks[(y << 8) | ci] & ID_MASK) !== 0) y++;
      if (y >= 110 || y < 8) continue;
      const tall = 3 + rng.int(6);
      for (let k = 0; k < tall && y + k < 116; k++) {
        blocks[((y + k) << 8) | ci] = packBlock(BONE_BLOCK, 0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The End
  // -------------------------------------------------------------------------

  /**
   * Island density in [0, 1] for an End column. 1 is the middle of solid land,
   * 0 is void. The central island decays with distance from the origin; a ring
   * of void follows; beyond radius 1000 the outer islands take over.
   */
  _endIsland(wx, wz) {
    const d = Math.sqrt(wx * wx + wz * wz);
    if (d < 1000) {
      let s = clamp(1.06 - d / 112, 0, 1);
      if (s > 0) {
        const n = this.nEnd.fbm2(wx * 0.0055, wz * 0.0055, 3, 2, 0.5);
        s = clamp(s * 1.12 + n * 0.4 * clamp(1 - d / 170, 0, 1), 0, 1);
      }
      if (d > 140) {
        // Sparse stepping-stone islands between the centre and the outer ring.
        const n2 = this.nEndIsland.fbm2(wx * 0.0062 + 13, wz * 0.0062 - 7, 2, 2, 0.5);
        s = Math.max(s, clamp((n2 - 0.40) * 5.5, 0, 1) * 0.55);
      }
      return s;
    }
    const n2 = this.nEndIsland.fbm2(wx * 0.0052, wz * 0.0052, 3, 2, 0.5);
    const big = this.nEnd.fbm2(wx * 0.0016, wz * 0.0016, 2, 2, 0.5);
    return clamp((n2 + big * 0.55 - 0.26) * 3.1, 0, 1);
  }

  /** Top surface of an End island, or -1 when the column is void. */
  _endTop(wx, wz) {
    const s = this._endIsland(wx, wz);
    if (s <= 0.03) return -1;
    return 52 + s * 22 + this.nEndDetail.fbm2(wx * 0.018, wz * 0.018, 3, 2, 0.5) * 6 * s;
  }

  /** @private Builds one End chunk. */
  _genEnd(chunk) {
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;
    blocks.fill(0);

    for (let lz = 0; lz < 16; lz++) {
      const wz = oz + lz;
      for (let lx = 0; lx < 16; lx++) {
        const wx = ox + lx;
        const ci = (lz << 4) | lx;
        const d = Math.sqrt(wx * wx + wz * wz);
        const s = this._endIsland(wx, wz);

        chunk.biomes[ci] = d < 150 ? EB.the_end
          : d < 1000 ? EB.small_end_islands
            : s > 0.62 ? EB.end_highlands
              : s > 0.28 ? EB.end_midlands : EB.end_barrens;

        if (s <= 0.03) continue;

        const top = 52 + s * 22 + this.nEndDetail.fbm2(wx * 0.018, wz * 0.018, 3, 2, 0.5) * 6 * s;
        const bulge = 0.6 + 0.4 * this.nEndUnder.fbm2(wx * 0.012 + 91, wz * 0.012, 2, 2, 0.5);
        const thick = 3 + s * 31 * bulge;
        const yTop = Math.min(WORLD_HEIGHT - 2, Math.floor(top));
        const yBot = Math.max(1, Math.floor(top - thick));
        for (let y = yBot; y <= yTop; y++) {
          // Lumpy undersides: eat away at the bottom few layers with 3D noise.
          if (y < yBot + 4) {
            const u = this.nEndUnder.perlin3(wx * 0.09, y * 0.09, wz * 0.09);
            if (u < -0.12 + (yBot + 4 - y) * 0.09) continue;
          }
          blocks[(y << 8) | ci] = V_END_STONE;
        }

        // Chorus plants grow on the outer islands only, as in vanilla.
        if (d > 1000 && yTop + 1 < WORLD_HEIGHT - 8) {
          const r = rand3(this.seed ^ 0xc407, wx, 0, wz);
          if (r < 0.006) this._chorus(blocks, ci, yTop + 1, wx, wz);
        }
      }
    }

    if (Math.abs(chunk.cx) <= 4 && Math.abs(chunk.cz) <= 4) this._endSpike(chunk);
    if (chunk.cx === 0 && chunk.cz === 0) this._exitPortal(chunk);
  }

  /** A small chorus plant stalk with a flower on top. */
  _chorus(blocks, ci, y0, wx, wz) {
    const tall = 2 + (hash3(this.seed ^ 0x5555, wx, wz, 3) % 4);
    for (let k = 0; k < tall; k++) {
      const y = y0 + k;
      if (y >= WORLD_HEIGHT - 1) return;
      blocks[(y << 8) | ci] = packBlock(k === tall - 1 ? CHORUS_FLOWER : CHORUS_PLANT, 0);
    }
  }

  /** The ten obsidian pillars ringing the central island. */
  _endSpike(chunk) {
    const ox = chunk.cx << 4, oz = chunk.cz << 4;
    const blocks = chunk.blocks;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const radius = 42 + (i % 3) * 3;
      const px = Math.round(Math.cos(a) * radius);
      const pz = Math.round(Math.sin(a) * radius);
      const r = 2 + (i % 3);
      if (px + r < ox || px - r > ox + 15 || pz + r < oz || pz - r > oz + 15) continue;
      const height = 78 + (i % 5) * 6;
      for (let lz = 0; lz < 16; lz++) {
        const wz = oz + lz;
        const dz = wz - pz;
        if (dz * dz > r * r) continue;
        for (let lx = 0; lx < 16; lx++) {
          const wx = ox + lx;
          const dx = wx - px;
          if (dx * dx + dz * dz > r * r) continue;
          const ci = (lz << 4) | lx;
          const base = Math.max(1, Math.floor(this._endTop(wx, wz)) - 4);
          const cap = Math.min(WORLD_HEIGHT - 3, height);
          for (let y = base; y <= cap; y++) blocks[(y << 8) | ci] = packBlock(OBSIDIAN, 0);
          // Bedrock plate under where the end crystal sits.
          if (dx === 0 && dz === 0 && cap + 1 < WORLD_HEIGHT) {
            blocks[((cap + 1) << 8) | ci] = V_BEDROCK;
          }
        }
      }
    }
  }

  /** The bedrock exit-portal frame at the world origin. */
  _exitPortal(chunk) {
    const blocks = chunk.blocks;
    let ground = Math.floor(this._endTop(2, 2));
    if (!(ground > 8)) ground = 60;
    ground = Math.min(ground, WORLD_HEIGHT - 10);
    const put = (x, y, z, v) => {
      if (x < 0 || x > 15 || z < 0 || z > 15 || y < 0 || y >= WORLD_HEIGHT) return;
      blocks[(y << 8) | (z << 4) | x] = v;
    };
    // The portal sits at local (0..4, 0..4); chunk 0,0 covers world 0..15.
    for (let dz = 0; dz <= 4; dz++) {
      for (let dx = 0; dx <= 4; dx++) {
        const edge = dx === 0 || dx === 4 || dz === 0 || dz === 4;
        put(dx, ground, dz, V_BEDROCK);
        if (edge) put(dx, ground + 1, dz, V_BEDROCK);
        else put(dx, ground + 1, dz, V_AIR);
        put(dx, ground + 2, dz, V_AIR);
      }
    }
    // Corner torch posts, so the frame is visible from a distance.
    for (const [dx, dz] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
      put(dx, ground + 2, dz, V_BEDROCK);
      put(dx, ground + 3, dz, V_BEDROCK);
      if (TORCH) put(dx, ground + 4, dz, packBlock(TORCH, 0));
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Fills chunk.blocks and chunk.biomes with terrain. Deterministic in
   * (seed, cx, cz); nothing here reads other chunks' contents.
   */
  generateChunk(chunk) {
    if (this.dimension === DIM_NETHER) this._genNether(chunk);
    else if (this.dimension === DIM_END) this._genEnd(chunk);
    else this._genOverworld(chunk);
    chunk.recomputeHeightmap();
    chunk.generated = true;
    chunk.dirty = true;
    return chunk;
  }

  /**
   * Runs ores, structures and decoration once the 3x3 neighbourhood has
   * terrain. Missing neighbours are generated here rather than skipped, so a
   * chunk is never left undecorated because of streaming order.
   */
  populateChunk(chunk, world) {
    if (!chunk || chunk.populated) return;
    if (world) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const n = world.getChunk(chunk.cx + dx, chunk.cz + dz, true);
          if (n && !n.generated) this.generateChunk(n);
        }
      }
    }

    const rng = new RNG(hash3(this.seed ^ 0xdec0, chunk.cx, chunk.cz, 0x5eed));
    if (world) {
      if (_features && typeof _features.generateOres === 'function') {
        try { _features.generateOres(chunk, world, rng); } catch (e) { console.error('[worldgen] ores', e); }
      }
      if (this.generateStructures !== false
          && _structures && typeof _structures.generateStructures === 'function') {
        try { _structures.generateStructures(chunk, world, rng); } catch (e) { console.error('[worldgen] structures', e); }
      }
      if (_features && typeof _features.decorateChunk === 'function') {
        try { _features.decorateChunk(chunk, world, rng); } catch (e) { console.error('[worldgen] decorate', e); }
      }
    }
    chunk.populated = true;
    chunk.dirty = true;
  }

  /** Biome id at a world column. */
  biomeAt(x, z) {
    const wx = Math.floor(x), wz = Math.floor(z);
    if (this.dimension === DIM_NETHER) return this._netherBiome(wx, wz);
    if (this.dimension === DIM_END) {
      const d = Math.sqrt(wx * wx + wz * wz);
      if (d < 150) return EB.the_end;
      if (d < 1000) return EB.small_end_islands;
      const s = this._endIsland(wx, wz);
      return s > 0.62 ? EB.end_highlands : s > 0.28 ? EB.end_midlands : EB.end_barrens;
    }
    return this._columnBiome(wx, wz);
  }

  /**
   * Surface height at a world column: the y of the first free cell above the
   * terrain, matching the "highest non-air y + 1" convention of the heightmap.
   */
  heightAt(x, z) {
    const wx = Math.floor(x), wz = Math.floor(z);
    if (this.dimension === DIM_NETHER) {
      // Walk down from just under the roof for the first floor with headroom.
      let air = 0;
      for (let y = NETHER_ROOF - 2; y >= 6; y--) {
        if (this._netherDensity(wx, y, wz) > NETHER_SOLID) {
          if (air >= 3) return y + 1;
          air = 0;
        } else if (y > 31) air++;
        else break;      // below the lava sea there is nothing to stand on
      }
      return 33;
    }
    if (this.dimension === DIM_END) {
      const t = this._endTop(wx, wz);
      return t < 0 ? 0 : Math.floor(t) + 1;
    }
    return Math.floor(this._terrainHeight(wx, wz)) + 1;
  }

  /**
   * Picks a safe spawn point: dry, above sea level, in a biome that is not an
   * ocean, a peak or the deep dark. Searches outward from the origin.
   */
  findSpawn(world) {
    if (this.dimension === DIM_END) {
      // Clear of the exit-portal frame, which occupies the origin.
      for (let r = 12; r < 70; r += 2) {
        const t = this._endTop(r, 0);
        if (t > 8) return { x: r + 0.5, y: Math.floor(t) + 1, z: 0.5 };
      }
      return { x: 0.5, y: 66, z: 0.5 };
    }
    if (this.dimension === DIM_NETHER) {
      let x = 0, z = 0, dx = 1, dz = 0, seg = 1, left = 1, turns = 0;
      for (let i = 0; i < 900; i++) {
        const wx = x * 4, wz = z * 4;
        const y = this._standingY(world, wx, wz, this.heightAt(wx, wz));
        if (y > 33 && y < 110) return { x: wx + 0.5, y, z: wz + 0.5 };
        x += dx; z += dz; left--;
        if (left === 0) { const t = dx; dx = -dz; dz = t; if (++turns % 2 === 0) seg++; left = seg; }
      }
      return { x: 0.5, y: 64, z: 0.5 };
    }

    let best = null;
    let x = 0, z = 0, dx = 1, dz = 0, seg = 1, left = 1, turns = 0;
    for (let i = 0; i < 24000; i++) {
      const wx = x * 8, wz = z * 8;
      const h = this.heightAt(wx, wz);
      if (h > SEA_LEVEL + 1 && h < 110) {
        const b = getBiome(this.biomeAt(wx, wz));
        if (!b.ocean && b.category !== 'ocean' && b.category !== 'river'
            && b.category !== 'beach' && b.category !== 'mountain' && !b.cave) {
          if (HOSPITABLE.has(b.category)) {
            const spot = { x: wx + 0.5, y: h, z: wz + 0.5 };
            if (this._spawnClear(world, wx, wz, h)) return spot;
            if (!best) best = spot;
          } else if (!best) {
            best = { x: wx + 0.5, y: h, z: wz + 0.5 };
          }
        }
      }
      x += dx; z += dz; left--;
      if (left === 0) { const t = dx; dx = -dz; dz = t; if (++turns % 2 === 0) seg++; left = seg; }
    }
    return best || { x: 0.5, y: this.heightAt(0, 0), z: 0.5 };
  }

  /**
   * Refines a predicted floor height against the loaded world when the chunk is
   * already there: scans down from `guess` for real ground with two blocks of
   * headroom. Returns -1 when nothing suitable is under the guess.
   */
  _standingY(world, wx, wz, guess) {
    if (!world || typeof world.getBlock !== 'function'
        || (typeof world.hasChunk === 'function' && !world.hasChunk(wx >> 4, wz >> 4))) {
      return guess;
    }
    for (let y = Math.min(WORLD_HEIGHT - 3, guess + 6); y > 4; y--) {
      const below = world.getBlock(wx, y - 1, wz);
      if (below === 0 || below === WATER || below === LAVA) continue;
      if (world.getBlock(wx, y, wz) === 0 && world.getBlock(wx, y + 1, wz) === 0) return y;
    }
    return -1;
  }

  /** True when the loaded world (if any) really has solid ground with headroom. */
  _spawnClear(world, wx, wz, h) {
    if (!world || typeof world.getBlock !== 'function') return true;
    if (typeof world.hasChunk === 'function' && !world.hasChunk(wx >> 4, wz >> 4)) return true;
    const below = world.getBlock(wx, h - 1, wz);
    if (below === 0 || below === WATER || below === LAVA) return false;
    return world.getBlock(wx, h, wz) === 0 && world.getBlock(wx, h + 1, wz) === 0;
  }
}

// ---------------------------------------------------------------------------
// Module-level tables used by the class above
// ---------------------------------------------------------------------------

/**
 * Height bias for the nether density field: solid under the lava sea, solid up
 * into the bedrock roof, free noise in between.
 */
/** Density above which the nether field counts as rock. */
const NETHER_SOLID = 0.10;

function netherBias(y) {
  if (y < 20) return (20 - y) * 0.13;
  if (y > 104) return (y - 104) * 0.075;
  return 0;
}

/** How many chunks away a carver system is still allowed to reach. */
const CARVE_RADIUS = 4;
const EMPTY_CARVE = new Float32Array(0);

const nbId = (name) => { const b = biomeByName(name); return b ? b.id : 0; };

/** The only land biome climate puts inside the ocean band. */
const MUSHROOM_ISLAND = nbId('mushroom_fields');

/** Nether biome ids by name. */
const NB = {
  nether_wastes: nbId('nether_wastes'),
  soul_sand_valley: nbId('soul_sand_valley'),
  crimson_forest: nbId('crimson_forest'),
  warped_forest: nbId('warped_forest'),
  basalt_deltas: nbId('basalt_deltas'),
};

/** End biome ids by name. */
const EB = {
  the_end: nbId('the_end'),
  end_highlands: nbId('end_highlands'),
  end_midlands: nbId('end_midlands'),
  end_barrens: nbId('end_barrens'),
  small_end_islands: nbId('small_end_islands'),
};

/** Resolved surface palette per biome, built on first use. */
const SURF = [];

function surfaceOf(biome) {
  const cached = SURF[biome.id];
  if (cached) return cached;
  const top = bid(biome.surface, GRASS_BLOCK);
  const filler = bid(biome.filler, DIRT);
  const under = bid(biome.underwater, GRAVEL);
  const badlands = biome.filler === 'terracotta';
  let deep = STONE;
  if (top === SAND) deep = SANDSTONE;
  else if (top === RED_SAND) deep = RED_SANDSTONE;
  else if (badlands) deep = TERRACOTTA;
  else if (top === MUD) deep = DIRT;
  const s = {
    top,
    filler,
    under,
    deepUnder: biome.ocean ? (under === SAND ? SAND : GRAVEL) : under,
    deep,
    badlands,
    wooded: biome.name === 'wooded_badlands',
    snowy: !!biome.snowy,
    // Sand, ice and snow blocks do not get a snow layer stacked on top.
    snowable: top !== SNOW_BLOCK && top !== PACKED_ICE && top !== BLUE_ICE
      && top !== SAND && top !== RED_SAND && top !== MUD,
    frozen: !!biome.snowy || biome.name.indexOf('frozen') >= 0,
    deepFreeze: biome.name.indexOf('frozen_ocean') >= 0 || biome.name === 'ice_spikes',
  };
  SURF[biome.id] = s;
  return s;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Builds the generator for one dimension.
 * @param {number|string} seed
 * @param {string} dimension 'overworld' | 'nether' | 'end'
 * @returns {WorldGen}
 */
export function createGenerator(seed, dimension = DIM_OVERWORLD) {
  return new WorldGen(seed, dimension);
}

/**
 * A tiny overworld height map for the world-creation screen.
 * Pixel (i, j) samples the world column (x0 + i*scale, z0 + j*scale); the value
 * is that column's surface height clamped to 0..255, so callers can compare it
 * against SEA_LEVEL to tell land from water.
 *
 * @param {number|string} seed
 * @param {number} x0 world x of the top-left pixel
 * @param {number} z0 world z of the top-left pixel
 * @param {number} w pixel width
 * @param {number} h pixel height
 * @param {number} [scale=4] world blocks per pixel
 * @returns {Uint8Array} w*h heights, row-major
 */
export function heightmapPreview(seed, x0, z0, w, h, scale = 4) {
  const width = Math.max(1, w | 0);
  const height = Math.max(1, h | 0);
  const step = Math.max(1, scale | 0);
  const gen = new WorldGen(seed, DIM_OVERWORLD);
  const out = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    const wz = (z0 | 0) + j * step;
    for (let i = 0; i < width; i++) {
      const v = gen._terrainHeight((x0 | 0) + i * step, wz);
      out[j * width + i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
  }
  return out;
}

export default WorldGen;
