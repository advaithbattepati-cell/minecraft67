// ============================================================================
// util.js - Small pure helpers. No imports besides constants.
// ============================================================================
import { CHUNK_X, CHUNK_Z } from './constants.js';

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export const sign = Math.sign;
export const floorDiv = (a, b) => Math.floor(a / b);
export const mod = (a, b) => ((a % b) + b) % b;
export const dist2 = (dx, dy) => Math.sqrt(dx * dx + dy * dy);
export const dist3 = (dx, dy, dz) => Math.sqrt(dx * dx + dy * dy + dz * dz);
export const distSq3 = (dx, dy, dz) => dx * dx + dy * dy + dz * dz;
export const approach = (cur, target, delta) =>
  cur < target ? Math.min(cur + delta, target) : Math.max(cur - delta, target);

/** Shortest signed angular difference from a to b, in radians. */
export function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
export const degToRad = (d) => (d * Math.PI) / 180;
export const radToDeg = (r) => (r * 180) / Math.PI;

// ---- Chunk coordinate helpers ----------------------------------------------
export const toChunkX = (x) => Math.floor(x / CHUNK_X);
export const toChunkZ = (z) => Math.floor(z / CHUNK_Z);
export const localX = (x) => mod(Math.floor(x), CHUNK_X);
export const localZ = (z) => mod(Math.floor(z), CHUNK_Z);
export const chunkKey = (cx, cz) => cx + ',' + cz;
export function parseChunkKey(key) { const i = key.indexOf(','); return [+key.slice(0, i), +key.slice(i + 1)]; }

// ---- Colors ----------------------------------------------------------------
export function hexToRgb(hex) {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
export const rgbToHex = (r, g, b) =>
  (Math.round(clamp(r, 0, 1) * 255) << 16) | (Math.round(clamp(g, 0, 1) * 255) << 8) | Math.round(clamp(b, 0, 1) * 255);
export function mixHex(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a), [br, bg, bb] = hexToRgb(b);
  return rgbToHex(lerp(ar, br, t), lerp(ag, bg, t), lerp(ab, bb, t));
}
export function hsvToRgb(h, s, v) {
  h = mod(h, 1) * 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
export function cssRgb(r, g, b, a = 1) {
  return `rgba(${Math.round(clamp(r, 0, 1) * 255)},${Math.round(clamp(g, 0, 1) * 255)},${Math.round(clamp(b, 0, 1) * 255)},${a})`;
}

// ---- AABB ------------------------------------------------------------------
export class AABB {
  constructor(x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0) {
    this.x0 = x0; this.y0 = y0; this.z0 = z0; this.x1 = x1; this.y1 = y1; this.z1 = z1;
  }
  static fromCenter(cx, cy, cz, w, h, d = w) {
    return new AABB(cx - w / 2, cy, cz - d / 2, cx + w / 2, cy + h, cz + d / 2);
  }
  set(x0, y0, z0, x1, y1, z1) { this.x0 = x0; this.y0 = y0; this.z0 = z0; this.x1 = x1; this.y1 = y1; this.z1 = z1; return this; }
  copy(o) { return this.set(o.x0, o.y0, o.z0, o.x1, o.y1, o.z1); }
  clone() { return new AABB(this.x0, this.y0, this.z0, this.x1, this.y1, this.z1); }
  offset(dx, dy, dz) { this.x0 += dx; this.y0 += dy; this.z0 += dz; this.x1 += dx; this.y1 += dy; this.z1 += dz; return this; }
  offsetCopy(dx, dy, dz) { return this.clone().offset(dx, dy, dz); }
  expand(dx, dy, dz) { this.x0 -= dx; this.y0 -= dy; this.z0 -= dz; this.x1 += dx; this.y1 += dy; this.z1 += dz; return this; }
  intersects(o) {
    return this.x0 < o.x1 && this.x1 > o.x0 && this.y0 < o.y1 && this.y1 > o.y0 && this.z0 < o.z1 && this.z1 > o.z0;
  }
  contains(x, y, z) {
    return x >= this.x0 && x <= this.x1 && y >= this.y0 && y <= this.y1 && z >= this.z0 && z <= this.z1;
  }
  get cx() { return (this.x0 + this.x1) / 2; }
  get cy() { return (this.y0 + this.y1) / 2; }
  get cz() { return (this.z0 + this.z1) / 2; }
  get width() { return this.x1 - this.x0; }
  get height() { return this.y1 - this.y0; }
  get depth() { return this.z1 - this.z0; }
}

/** Slab-method ray/box intersection. Returns hit distance or -1. */
export function rayAABB(ox, oy, oz, dx, dy, dz, box) {
  let tmin = -Infinity, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [box.x0, box.y0, box.z0], hi = [box.x1, box.y1, box.z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-8) { if (o[i] < lo[i] || o[i] > hi[i]) return -1; continue; }
    const inv = 1 / d[i];
    let t0 = (lo[i] - o[i]) * inv, t1 = (hi[i] - o[i]) * inv;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
    if (tmin > tmax) return -1;
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : -1);
}

// ---- Misc ------------------------------------------------------------------
/** Title-cases a snake_case identifier: "diamond_sword" -> "Diamond Sword". */
export function prettyName(id) {
  return String(id).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function formatTime(ticks) {
  const t = mod(ticks, 24000);
  const h = Math.floor((t / 1000 + 6) % 24);
  const m = Math.floor(((t % 1000) / 1000) * 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
/** Roman numerals for enchantment levels. */
export function roman(n) {
  if (n <= 0 || n > 3999) return String(n);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
  let out = '';
  for (let i = 0; i < vals.length; i++) while (n >= vals[i]) { out += syms[i]; n -= vals[i]; }
  return out;
}
export function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }

/** Calls fn at most once per `ms`. */
export function throttle(fn, ms) {
  let last = 0;
  return (...args) => { const now = performance.now(); if (now - last >= ms) { last = now; fn(...args); } };
}

/** A tiny fixed-capacity priority queue (min-heap) used by pathfinding. */
export class MinHeap {
  constructor(scoreOf) { this.items = []; this.scoreOf = scoreOf; }
  get size() { return this.items.length; }
  push(item) {
    const a = this.items; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.scoreOf(a[i]) >= this.scoreOf(a[p])) break;
      const t = a[i]; a[i] = a[p]; a[p] = t; i = p;
    }
  }
  pop() {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.scoreOf(a[l]) < this.scoreOf(a[m])) m = l;
        if (r < a.length && this.scoreOf(a[r]) < this.scoreOf(a[m])) m = r;
        if (m === i) break;
        const t = a[i]; a[i] = a[m]; a[m] = t; i = m;
      }
    }
    return top;
  }
}
