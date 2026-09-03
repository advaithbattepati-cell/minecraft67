// ============================================================================
// rng.js - Deterministic pseudo-random numbers and coherent noise.
// No imports. Everything here is pure and seedable.
// ============================================================================

// ---- Hashing ---------------------------------------------------------------
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 32-bit integer hash of up to four coordinates plus a seed. Returns uint32. */
export function hash3(seed, x, y = 0, z = 0) {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (y | 0), 0x85ebca6b);
  h = Math.imul(h ^ (z | 0), 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return h >>> 0;
}

/** Deterministic float in [0,1) from coordinates. */
export const hashFloat = (seed, x, y = 0, z = 0) => hash3(seed, x, y, z) / 4294967296;

// ---- Seeded PRNG (mulberry32) ---------------------------------------------
export class RNG {
  constructor(seed = 0) { this.state = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1; }
  /** float in [0,1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [0, n) */
  int(n) { return Math.floor(this.next() * n); }
  /** integer in [min, max] inclusive */
  range(min, max) { return min + Math.floor(this.next() * (max - min + 1)); }
  /** float in [min, max) */
  float(min, max) { return min + this.next() * (max - min); }
  /** true with probability p */
  chance(p) { return this.next() < p; }
  bool() { return this.next() < 0.5; }
  /** random element of an array (undefined if empty) */
  pick(arr) { return arr.length ? arr[Math.floor(this.next() * arr.length)] : undefined; }
  /** weighted pick: entries are [value, weight] pairs or objects with .weight */
  pickWeighted(entries, weightOf = (e) => (Array.isArray(e) ? e[1] : e.weight ?? 1)) {
    let total = 0;
    for (const e of entries) total += weightOf(e);
    let r = this.next() * total;
    for (const e of entries) { r -= weightOf(e); if (r <= 0) return e; }
    return entries[entries.length - 1];
  }
  /** in-place Fisher-Yates shuffle */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  /** normally distributed value (Box-Muller), mean 0 stddev 1 */
  gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  fork(salt = 0) { return new RNG(hash3(this.state, salt, 0x9e37, 0x79b9)); }
}

/** Convenience: an RNG deterministically derived from a seed and coordinates. */
export const rngAt = (seed, x, y = 0, z = 0) => new RNG(hash3(seed, x, y, z));

// ---- Perlin / Simplex noise ------------------------------------------------
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

export class Noise {
  constructor(seed = 0) {
    const rng = new RNG(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    rng.shuffle(p);
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
    this.seed = seed;
  }

  /** Classic 2D Perlin noise. Returns roughly [-1, 1]. */
  perlin2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const p = this.perm;
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const g = (h, dx, dy) => { const gr = GRAD3[h % 12]; return gr[0] * dx + gr[1] * dy; };
    const x1 = lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u);
    const x2 = lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /** Classic 3D Perlin noise. Returns roughly [-1, 1]. */
  perlin3(x, y, z) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y), zf = z - Math.floor(z);
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const p = this.perm;
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const g = (h, dx, dy, dz) => { const gr = GRAD3[h % 12]; return gr[0] * dx + gr[1] * dy + gr[2] * dz; };
    const x1 = lerp(g(p[AA], xf, yf, zf), g(p[BA], xf - 1, yf, zf), u);
    const x2 = lerp(g(p[AB], xf, yf - 1, zf), g(p[BB], xf - 1, yf - 1, zf), u);
    const y1 = lerp(x1, x2, v);
    const x3 = lerp(g(p[AA + 1], xf, yf, zf - 1), g(p[BA + 1], xf - 1, yf, zf - 1), u);
    const x4 = lerp(g(p[AB + 1], xf, yf - 1, zf - 1), g(p[BB + 1], xf - 1, yf - 1, zf - 1), u);
    const y2 = lerp(x3, x4, v);
    return lerp(y1, y2, w);
  }

  /** 2D simplex noise, smoother and cheaper than perlin. Roughly [-1, 1]. */
  simplex2(xin, yin) {
    const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const pm = this.permMod12, p = this.perm;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { const g = GRAD3[pm[ii + p[jj]]]; t0 *= t0; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { const g = GRAD3[pm[ii + i1 + p[jj + j1]]]; t1 *= t1; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { const g = GRAD3[pm[ii + 1 + p[jj + 1]]]; t2 *= t2; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * (n0 + n1 + n2);
  }

  /** Fractal Brownian motion over simplex2. */
  fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Fractal Brownian motion over perlin3. */
  fbm3(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.perlin3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal - good for mountain ridges. Returns [0, 1]. */
  ridged2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * (1 - Math.abs(this.simplex2(x * freq, y * freq)));
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Billowy noise (absolute value). Returns [0, 1]. */
  billow2(x, y, octaves = 4) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * Math.abs(this.simplex2(x * freq, y * freq));
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }

  /** Cellular / Worley noise. Returns {f1, f2, id} - distances to two nearest points. */
  cellular2(x, y, jitter = 1) {
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = Infinity, f2 = Infinity, id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy;
        const h = hash3(this.seed, cx, cy, 0);
        const px = cx + ((h & 0xffff) / 65536) * jitter;
        const py = cy + (((h >>> 16) & 0xffff) / 65536) * jitter;
        const d = Math.hypot(px - x, py - y);
        if (d < f1) { f2 = f1; f1 = d; id = h; } else if (d < f2) { f2 = d; }
      }
    }
    return { f1, f2, id };
  }
}

/** A small bundle of independent noise fields derived from one seed. */
export function noiseSet(seed, names) {
  const out = {};
  names.forEach((n, i) => { out[n] = new Noise(hash3(seed, i + 1, 0xabcd, 0x1234)); });
  return out;
}
