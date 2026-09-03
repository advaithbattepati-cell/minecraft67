// ============================================================================
// save.js - Persistence. IndexedDB world storage, autosave, import/export.
//
// Layout of the `minecraft67` database (version 1):
//
//   worlds    keyPath 'name'    one metadata record per world
//   chunks    keyPath 'key'     key = 'world|dimension|cx,cz'
//   players   keyPath 'world'   one player record per world
//   settings  keyPath 'key'     small key/value blobs
//
// Two ideas drive the whole file:
//
//   1. Only *modified* chunks are written. A chunk that came straight out of
//      the generator and was never touched costs nothing to "save", because we
//      can regenerate it byte-for-byte from the seed. `markChunkModified()`
//      (and Chunk.markDirty itself) raises `chunk.modified`; the save pass
//      collects those and lowers the flag once the write commits.
//
//   2. Nothing here may ever stall a frame or throw into the game loop.
//      `autoSaveTick()` is synchronous and just kicks off a promise; the save
//      itself writes chunks in small batches and yields to the host between
//      them. Every public method catches its own errors and degrades to an
//      in-memory store if IndexedDB is missing (private browsing, blocked
//      storage, file:// origins).
//
// Typed arrays are handed to IndexedDB directly - structured clone copies them
// synchronously at put() time, so the live chunk arrays can keep mutating.
// ============================================================================
import { Game } from '../core/game.js';
import { Chunk } from '../world/chunk.js';
import {
  DIM_OVERWORLD, DIM_NETHER, DIM_END,
  GAMEMODE, DIFFICULTY, MAX_HEALTH, MAX_HUNGER, MAX_AIR,
} from '../core/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** IndexedDB database name. */
export const DB_NAME = 'minecraft67';
/** IndexedDB schema version. Bump + extend upgradeSchema() when stores change. */
export const DB_VERSION = 1;

export const STORE_WORLDS = 'worlds';
export const STORE_CHUNKS = 'chunks';
export const STORE_PLAYERS = 'players';
export const STORE_SETTINGS = 'settings';

/** Save-format revision written into every record. */
export const SAVE_VERSION = 1;
/** Magic string in exported JSON files. */
export const SAVE_FORMAT = 'minecraft67-world';
/** Autosave cadence: 30 seconds of *unpaused* play. */
export const AUTOSAVE_INTERVAL_MS = 30000;

/** Object store -> key path. Also the list of stores created on upgrade. */
const STORE_KEYPATHS = {
  [STORE_WORLDS]: 'name',
  [STORE_CHUNKS]: 'key',
  [STORE_PLAYERS]: 'world',
  [STORE_SETTINGS]: 'key',
};

const DIMENSIONS = [DIM_OVERWORLD, DIM_NETHER, DIM_END];
const CHUNKS_PER_TRANSACTION = 16;      // ~1.6 MB of structured clone per batch
const OPEN_TIMEOUT_MS = 8000;           // Safari private mode can hang forever
const PENDING_LIMIT = 20000;            // cap on the dirty-chunk side table
const THUMBNAIL_INTERVAL_MS = 60000;
const MAX_CONSECUTIVE_ERRORS = 3;       // after this we fall back to memory
const SETTINGS_STORAGE_KEY = 'mc67.settings';
/** Upper bound for a world's key range: every chunk key sorts below this. */
const KEY_HIGH = '\uffff';

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

/** The SaveManager everything shares; see getSaveManager(). */
let activeManager = null;

const warnedKeys = new Set();
/** console.warn a message at most once per key, so a broken DB is not spam. */
function warnOnce(key, ...args) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn('[save]', ...args);
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const bool = (v) => !!v;

/** Monotonic milliseconds; falls back to Date.now where performance is absent. */
function monotonic() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/** Yields to the host so a long save never blocks a frame. */
function yieldToHost() {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 50 });
    else if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

/** Composite chunk key: 'world|dimension|cx,cz'. */
export function chunkRecordKey(worldName, dimension, cx, cz) {
  return `${worldName}|${dimension}|${cx | 0},${cz | 0}`;
}

/** Inclusive key range covering every chunk of one world (optionally one dim). */
function worldChunkRange(worldName, dimension = null) {
  const prefix = dimension ? `${worldName}|${dimension}|` : `${worldName}|`;
  return { lower: prefix, upper: prefix + KEY_HIGH };
}

function inRange(key, range) {
  if (!range) return true;
  if (range.only !== undefined) return key === range.only;
  if (range.lower !== undefined && key < range.lower) return false;
  if (range.upper !== undefined && key > range.upper) return false;
  return true;
}

const TYPED_ARRAYS = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array,
};
const isTypedArray = (v) => ArrayBuffer.isView(v) && !(v instanceof DataView);

/**
 * Keys that must not be followed when their value is an *object*: they hold
 * live back-references that would drag half the game into the save. A
 * primitive under the same name (a spawner's `entity: 'zombie'`, say) is real
 * data and is kept.
 */
const SKIP_KEYS = new Set([
  'world', 'chunk', 'game', 'entity', 'owner', 'parent', 'target', 'player',
  'onChange', 'onTick', 'mesh', 'group', 'texture', 'renderer', 'scene', 'camera',
]);

/**
 * Deep-copies `value` into something IndexedDB's structured clone will accept:
 * drops functions, DOM nodes and live back-references, keeps typed arrays,
 * Maps, Sets and Dates, and breaks cycles. Never throws.
 */
export function toCloneable(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') return Number(value);
  if (t === 'function' || t === 'symbol') return undefined;
  if (depth > 8) return undefined;
  if (isTypedArray(value) || value instanceof ArrayBuffer) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const v = toCloneable(value[i], depth + 1, seen);
        out[i] = v === undefined ? null : v;
      }
      return out;
    }
    if (value instanceof Map) {
      const out = new Map();
      for (const [k, v] of value) {
        const cv = toCloneable(v, depth + 1, seen);
        if (cv !== undefined) out.set(typeof k === 'object' ? String(k) : k, cv);
      }
      return out;
    }
    if (value instanceof Set) {
      const out = [];
      for (const v of value) { const cv = toCloneable(v, depth + 1, seen); if (cv !== undefined) out.push(cv); }
      return new Set(out);
    }
    if (typeof Node !== 'undefined' && value instanceof Node) return undefined;
    const out = {};
    for (const k of Object.keys(value)) {
      const raw = value[k];
      if (SKIP_KEYS.has(k) && raw !== null && typeof raw === 'object') continue;
      const v = toCloneable(raw, depth + 1, seen);
      if (v !== undefined) out[k] = v;
    }
    return out;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

/**
 * Faithful deep copy: unlike toCloneable it keeps every key, because records
 * reaching the store have already been sanitized and their key paths must
 * survive. Used only as the structuredClone fallback.
 */
function plainCopy(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12 || seen.has(value)) return null;
  if (isTypedArray(value)) return value.slice();
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Date) return new Date(value.getTime());
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => plainCopy(v, depth + 1, seen));
    if (value instanceof Map) {
      const out = new Map();
      for (const [k, v] of value) out.set(k, plainCopy(v, depth + 1, seen));
      return out;
    }
    if (value instanceof Set) {
      const out = new Set();
      for (const v of value) out.add(plainCopy(v, depth + 1, seen));
      return out;
    }
    const out = {};
    for (const k of Object.keys(value)) out[k] = plainCopy(value[k], depth + 1, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Structured-clone snapshot used by the in-memory backend. Never throws. */
function snapshot(value) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch { /* value held something exotic - fall through */ }
  try {
    return plainCopy(value);
  } catch {
    return toCloneable(value);
  }
}

// ---- base64 (self-contained: no btoa/Buffer dependency) --------------------
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(128);
  t.fill(255);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

/** Uint8Array -> base64 string. */
function bytesToBase64(bytes) {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64_CHARS[a >> 2] + B64_CHARS[((a & 3) << 4) | (b >> 4)] +
           B64_CHARS[((b & 15) << 2) | (c >> 6)] + B64_CHARS[c & 63];
  }
  const rem = n - i;
  if (rem === 1) {
    const a = bytes[i];
    out += B64_CHARS[a >> 2] + B64_CHARS[(a & 3) << 4] + '==';
  } else if (rem === 2) {
    const a = bytes[i], b = bytes[i + 1];
    out += B64_CHARS[a >> 2] + B64_CHARS[((a & 3) << 4) | (b >> 4)] + B64_CHARS[(b & 15) << 2] + '=';
  }
  return out;
}

/** base64 string -> Uint8Array. */
function base64ToBytes(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  const outLen = (clean.length * 3) >> 2;
  const out = new Uint8Array(outLen);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? B64_LOOKUP[code] : 255;
    if (v === 255) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return o === outLen ? out : out.subarray(0, o);
}

// ---- JSON-safe encoding for export/import ----------------------------------

/** Max elements one RLE run can cover (counts travel as Uint16). */
const RLE_MAX_RUN = 65535;

/**
 * Run-length encodes a typed array. Chunk block/light data is enormously
 * repetitive (stone columns, solid sky light), so this typically shrinks an
 * exported chunk by an order of magnitude. Returns null when RLE would not
 * pay for itself.
 */
function rleEncodeTyped(arr) {
  const Ctor = arr.constructor;
  const n = arr.length;
  if (n === 0) return null;
  const per = Ctor.BYTES_PER_ELEMENT || 1;
  const maxRuns = Math.floor((n * per * 0.8) / (per + 2));   // 20% saving floor
  const values = new Ctor(n);
  const counts = new Uint16Array(n);
  let runs = 0;
  let i = 0;
  while (i < n) {
    const v = arr[i];
    let c = 1;
    while (i + c < n && arr[i + c] === v && c < RLE_MAX_RUN) c++;
    if (runs > maxRuns) return null;      // too noisy - keep the raw bytes
    values[runs] = v;
    counts[runs] = c;
    runs++;
    i += c;
  }
  return {
    $rle: Ctor.name,
    n,
    v: bytesToBase64(new Uint8Array(values.buffer, 0, runs * per)),
    c: bytesToBase64(new Uint8Array(counts.buffer, 0, runs * 2)),
  };
}

/** Expands an rleEncodeTyped() descriptor back into a typed array. */
function rleDecodeTyped(desc) {
  const Ctor = TYPED_ARRAYS[desc.$rle] || Uint8Array;
  const per = Ctor.BYTES_PER_ELEMENT || 1;
  const out = new Ctor(Math.max(0, desc.n | 0));
  const vb = base64ToBytes(desc.v || '');
  const cb = base64ToBytes(desc.c || '');
  const vAligned = new Uint8Array(vb.length - (vb.length % per));
  vAligned.set(vb.subarray(0, vAligned.length));
  const cAligned = new Uint8Array(cb.length - (cb.length % 2));
  cAligned.set(cb.subarray(0, cAligned.length));
  const values = new Ctor(vAligned.buffer, 0, vAligned.length / per);
  const counts = new Uint16Array(cAligned.buffer, 0, cAligned.length / 2);
  const runs = Math.min(values.length, counts.length);
  let o = 0;
  for (let i = 0; i < runs && o < out.length; i++) {
    const v = values[i];
    let c = counts[i];
    if (o + c > out.length) c = out.length - o;
    out.fill(v, o, o + c);
    o += c;
  }
  return out;
}

/** Converts a record tree into JSON-safe values (typed arrays -> base64). */
function encodeValue(v, depth = 0) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (t === 'function' || t === 'symbol') return null;
  if (depth > 12) return null;
  if (isTypedArray(v)) {
    const rle = rleEncodeTyped(v);
    if (rle) return rle;
    return { $ta: v.constructor.name, b: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (v instanceof ArrayBuffer) return { $ta: 'Uint8Array', b: bytesToBase64(new Uint8Array(v)) };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, val]) => [encodeValue(k, depth + 1), encodeValue(val, depth + 1)]) };
  if (v instanceof Set) return { $set: [...v.values()].map((val) => encodeValue(val, depth + 1)) };
  if (Array.isArray(v)) return v.map((x) => encodeValue(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    const e = encodeValue(v[k], depth + 1);
    if (e !== undefined) out[k] = e;
  }
  return out;
}

/** Reverses encodeValue(). */
function decodeValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  if (typeof v.$rle === 'string') return rleDecodeTyped(v);
  if (typeof v.$ta === 'string') {
    const Ctor = TYPED_ARRAYS[v.$ta] || Uint8Array;
    const bytes = base64ToBytes(v.b || '');
    const per = Ctor.BYTES_PER_ELEMENT || 1;
    const copy = new Uint8Array(bytes.length - (bytes.length % per));
    copy.set(bytes.subarray(0, copy.length));
    return new Ctor(copy.buffer, 0, copy.length / per);
  }
  if (typeof v.$date === 'string') return new Date(v.$date);
  if (Array.isArray(v.$map)) return new Map(v.$map.map(([k, val]) => [decodeValue(k), decodeValue(val)]));
  if (Array.isArray(v.$set)) return new Set(v.$set.map(decodeValue));
  const out = {};
  for (const k of Object.keys(v)) out[k] = decodeValue(v[k]);
  return out;
}

// ---------------------------------------------------------------------------
// Storage backends
// ---------------------------------------------------------------------------

/** Wraps an IDBRequest in a promise. */
function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/** Resolves when a transaction commits, rejects when it errors or aborts. */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function toIDBRange(range) {
  if (!range) return null;
  try {
    if (range.only !== undefined) return IDBKeyRange.only(range.only);
    if (range.lower !== undefined && range.upper !== undefined) return IDBKeyRange.bound(range.lower, range.upper);
    if (range.lower !== undefined) return IDBKeyRange.lowerBound(range.lower);
    if (range.upper !== undefined) return IDBKeyRange.upperBound(range.upper);
  } catch { /* fall through */ }
  return null;
}

/** Creates every object store + index. Runs inside onupgradeneeded. */
function upgradeSchema(db, oldVersion) {
  if (!db.objectStoreNames.contains(STORE_WORLDS)) {
    const s = db.createObjectStore(STORE_WORLDS, { keyPath: 'name' });
    s.createIndex('lastPlayed', 'lastPlayed', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
    const s = db.createObjectStore(STORE_CHUNKS, { keyPath: 'key' });
    s.createIndex('world', 'world', { unique: false });
    s.createIndex('wd', 'wd', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE_PLAYERS)) {
    db.createObjectStore(STORE_PLAYERS, { keyPath: 'world' });
  }
  if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
    db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
  }
  // oldVersion === 0 means a fresh database; future migrations branch here.
  void oldVersion;
}

/** IndexedDB-backed store. All methods return promises and may reject. */
class IDBBackend {
  constructor(db) {
    this.kind = 'indexeddb';
    this.db = db;
  }

  _tx(store, mode) { return this.db.transaction(store, mode); }

  async get(store, key) {
    const tx = this._tx(store, 'readonly');
    const req = tx.objectStore(store).get(String(key));
    const result = await idbRequest(req);
    return result;
  }

  async getAll(store, range = null, count = 0) {
    const tx = this._tx(store, 'readonly');
    const os = tx.objectStore(store);
    const r = toIDBRange(range);
    const req = count > 0 ? os.getAll(r, count) : os.getAll(r);
    return (await idbRequest(req)) || [];
  }

  async getAllKeys(store, range = null) {
    const tx = this._tx(store, 'readonly');
    const req = tx.objectStore(store).getAllKeys(toIDBRange(range));
    return (await idbRequest(req)) || [];
  }

  async put(store, value) {
    return this.putMany(store, [value]);
  }

  async putMany(store, values) {
    if (!values.length) return 0;
    const tx = this._tx(store, 'readwrite');
    const os = tx.objectStore(store);
    for (let i = 0; i < values.length; i++) os.put(values[i]);
    await txDone(tx);
    return values.length;
  }

  async delete(store, key) {
    const tx = this._tx(store, 'readwrite');
    tx.objectStore(store).delete(String(key));
    await txDone(tx);
    return true;
  }

  async deleteRange(store, range) {
    const r = toIDBRange(range);
    const tx = this._tx(store, 'readwrite');
    tx.objectStore(store).delete(r || IDBKeyRange.lowerBound(''));
    await txDone(tx);
    return true;
  }

  async count(store, range = null) {
    const tx = this._tx(store, 'readonly');
    return (await idbRequest(tx.objectStore(store).count(toIDBRange(range)))) || 0;
  }

  async clear(store) {
    const tx = this._tx(store, 'readwrite');
    tx.objectStore(store).clear();
    await txDone(tx);
    return true;
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

/**
 * Drop-in replacement used when IndexedDB is unavailable or broken. The game
 * stays fully playable; the world simply does not outlive the tab.
 */
class MemoryBackend {
  constructor() {
    this.kind = 'memory';
    this.stores = new Map();
    for (const name of Object.keys(STORE_KEYPATHS)) this.stores.set(name, new Map());
  }

  _s(name) {
    let m = this.stores.get(name);
    if (!m) { m = new Map(); this.stores.set(name, m); }
    return m;
  }

  async get(store, key) {
    const v = this._s(store).get(String(key));
    return v === undefined ? undefined : snapshot(v);
  }

  async getAll(store, range = null, count = 0) {
    const m = this._s(store);
    const keys = [...m.keys()].sort();
    const out = [];
    for (const k of keys) {
      if (!inRange(k, range)) continue;
      out.push(snapshot(m.get(k)));
      if (count > 0 && out.length >= count) break;
    }
    return out;
  }

  async getAllKeys(store, range = null) {
    return [...this._s(store).keys()].sort().filter((k) => inRange(k, range));
  }

  async put(store, value) {
    const keyPath = STORE_KEYPATHS[store] || 'key';
    this._s(store).set(String(value[keyPath]), snapshot(value));
    return 1;
  }

  async putMany(store, values) {
    for (let i = 0; i < values.length; i++) await this.put(store, values[i]);
    return values.length;
  }

  async delete(store, key) { this._s(store).delete(String(key)); return true; }

  async deleteRange(store, range) {
    const m = this._s(store);
    for (const k of [...m.keys()]) if (inRange(k, range)) m.delete(k);
    return true;
  }

  async count(store, range = null) {
    if (!range) return this._s(store).size;
    let n = 0;
    for (const k of this._s(store).keys()) if (inRange(k, range)) n++;
    return n;
  }

  async clear(store) { this._s(store).clear(); return true; }

  close() { /* nothing to release */ }
}

/** Opens the database, creating/upgrading the schema. Rejects on failure. */
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB is not available in this context'));
      return;
    }
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    // Safari/Firefox private mode can leave open() hanging forever.
    const timer = typeof setTimeout === 'function'
      ? setTimeout(() => finish(reject, new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS)
      : null;
    const clearTimer = () => { if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer); };

    req.onupgradeneeded = (ev) => {
      try { upgradeSchema(req.result, ev.oldVersion || 0); }
      catch (e) { console.warn('[save] schema upgrade failed', e); }
    };
    req.onsuccess = () => { clearTimer(); finish(resolve, req.result); };
    req.onerror = () => { clearTimer(); finish(reject, req.error || new Error('IndexedDB open failed')); };
    req.onblocked = () => { clearTimer(); finish(reject, new Error('IndexedDB open blocked by another tab')); };
  });
}

// ---------------------------------------------------------------------------
// Snapshot builders (game state -> plain records)
// ---------------------------------------------------------------------------

/** Every distinct loaded World, as [dimensionName, world] pairs. */
function worldEntries(game) {
  const out = [];
  const seen = new Set();
  const map = game?.worlds;
  if (map) {
    for (const key of Object.keys(map)) {
      const w = map[key];
      if (w && typeof w === 'object' && !seen.has(w)) { seen.add(w); out.push([str(w.dimension, key), w]); }
    }
  }
  const active = game?.world;
  if (active && !seen.has(active)) { seen.add(active); out.push([str(active.dimension, DIM_OVERWORLD), active]); }
  return out;
}

function captureWeather(world) {
  const w = world?.weather || {};
  return {
    rain: num(w.rain), thunder: num(w.thunder),
    rainTicks: num(w.rainTicks), thunderTicks: num(w.thunderTicks),
  };
}

function capturePoint(p, fallback = null) {
  if (!p || typeof p !== 'object') return fallback;
  const out = { x: num(p.x), y: num(p.y), z: num(p.z) };
  if (typeof p.dimension === 'string') out.dimension = p.dimension;
  return out;
}

/** Per-dimension state: time, weather and spawn point. */
function captureDimensions(game) {
  const dims = {};
  for (const [name, w] of worldEntries(game)) {
    dims[name] = {
      time: num(w.time),
      totalTime: num(w.totalTime),
      weather: captureWeather(w),
      spawnPoint: capturePoint(w.spawnPoint),
      chunksLoaded: w.chunks?.size | 0,
    };
  }
  return dims;
}

/** Status effects as a plain array. */
function captureEffects(entity) {
  const out = [];
  const m = entity?.effects;
  if (m instanceof Map) {
    for (const [name, v] of m) {
      out.push({ name: String(name), level: num(v?.level, 0), ticks: num(v?.ticks, 0), ambient: bool(v?.ambient) });
    }
  } else if (m && typeof m === 'object') {
    for (const name of Object.keys(m)) {
      const v = m[name];
      out.push({ name, level: num(v?.level, 0), ticks: num(v?.ticks, 0), ambient: bool(v?.ambient) });
    }
  }
  return out;
}

/** Inventory contents, armour and offhand included. */
function captureInventory(inv) {
  if (!inv || typeof inv !== 'object') return null;
  let data = null;
  try { if (typeof inv.serialize === 'function') data = inv.serialize(); } catch (e) { warnOnce('inv-ser', 'inventory.serialize() failed', e); }
  if (data == null) {
    const slots = [];
    const size = num(inv.size, Array.isArray(inv.slots) ? inv.slots.length : 0);
    for (let i = 0; i < size; i++) {
      const s = typeof inv.get === 'function' ? inv.get(i) : inv.slots?.[i];
      slots.push(s || null);
    }
    data = { size, slots, name: str(inv.name), selected: num(inv.selected, 0) };
  }
  return toCloneable(data);
}

/** Snapshot of the four armour slots (head, chest, legs, feet). */
function captureArmor(inv) {
  if (!inv) return null;
  const out = [];
  for (let i = 0; i < 4; i++) {
    let s = null;
    if (typeof inv.getArmor === 'function') { try { s = inv.getArmor(i); } catch { s = null; } }
    else if (typeof inv.get === 'function') s = inv.get(36 + i);
    out.push(toCloneable(s) || null);
  }
  return out;
}

function captureOffhand(inv) {
  if (!inv) return null;
  let s = null;
  if (typeof inv.getOffhand === 'function') { try { s = inv.getOffhand(); } catch { s = null; } }
  else if (typeof inv.get === 'function') s = inv.get(40);
  return toCloneable(s) || null;
}

/**
 * Full player record: position, rotation, health, hunger, xp, effects,
 * inventory (armour + offhand), respawn point and game mode.
 */
function capturePlayer(game, worldName) {
  const rec = { world: worldName, savedAt: Date.now(), version: SAVE_VERSION };
  const p = game?.player;
  if (!p) return rec;

  // Start from whatever the entity itself considers worth saving, then let the
  // explicit fields below win - those are the ones the contract guarantees.
  try {
    if (typeof p.serialize === 'function') {
      const base = toCloneable(p.serialize());
      if (base && typeof base === 'object' && !Array.isArray(base)) Object.assign(rec, base);
    }
  } catch (e) { warnOnce('player-ser', 'player.serialize() failed', e); }

  const inv = p.inventory;
  rec.type = 'player';
  rec.dimension = str(p.world?.dimension, str(game?.dimension, DIM_OVERWORLD));
  rec.x = num(p.x); rec.y = num(p.y); rec.z = num(p.z);
  rec.vx = num(p.vx); rec.vy = num(p.vy); rec.vz = num(p.vz);
  rec.yaw = num(p.yaw); rec.pitch = num(p.pitch); rec.headYaw = num(p.headYaw, num(p.yaw));
  rec.onGround = bool(p.onGround);

  rec.health = num(p.health, MAX_HEALTH);
  rec.maxHealth = num(p.maxHealth, MAX_HEALTH);
  rec.absorption = num(p.absorption, 0);
  rec.hunger = num(p.hunger, MAX_HUNGER);
  rec.saturation = num(p.saturation, 5);
  rec.exhaustion = num(p.exhaustion, 0);
  rec.airSupply = num(p.airSupply, MAX_AIR);
  rec.fireTicks = num(p.fireTicks, 0);
  rec.fallDistance = num(p.fallDistance, 0);
  rec.age = num(p.age, 0);
  rec.dead = bool(p.dead);

  rec.xp = num(p.xp, 0);
  rec.xpLevel = num(p.xpLevel, 0);
  rec.xpProgress = num(p.xpProgress, 0);

  rec.gameMode = str(p.gameMode, str(game?.mode, GAMEMODE.SURVIVAL));
  rec.flying = bool(p.flying);
  rec.canFly = bool(p.canFly);
  rec.sneaking = bool(p.sneaking);
  rec.sprinting = bool(p.sprinting);

  rec.effects = captureEffects(p);
  rec.inventory = captureInventory(inv);
  rec.armor = captureArmor(inv);
  rec.offhand = captureOffhand(inv);
  rec.selectedSlot = num(p.selectedSlot, num(inv?.selected, 0));
  if (p.enderChest) rec.enderChest = captureInventory(p.enderChest);
  rec.respawnPoint = capturePoint(p.respawnPoint, null);
  if (p.stats && typeof p.stats === 'object') rec.stats = toCloneable(p.stats);

  rec.world = worldName;   // keyPath - always last so nothing can clobber it
  return rec;
}

/** Serializable chunk record for the 'chunks' store. */
function chunkRecord(worldName, dimension, chunk) {
  let s = null;
  try { if (typeof chunk.serialize === 'function') s = chunk.serialize(); } catch (e) { warnOnce('chunk-ser', 'chunk.serialize() failed', e); }
  if (!s) {
    s = {
      cx: chunk.cx, cz: chunk.cz,
      blocks: chunk.blocks, light: chunk.light,
      heightmap: chunk.heightmap, biomes: chunk.biomes,
      blockEntities: chunk.blockEntities,
      generated: chunk.generated, populated: chunk.populated, lit: chunk.lit,
    };
  }
  const cx = num(s.cx, chunk.cx | 0) | 0;
  const cz = num(s.cz, chunk.cz | 0) | 0;
  return {
    key: chunkRecordKey(worldName, dimension, cx, cz),
    world: worldName,
    wd: `${worldName}|${dimension}`,
    dim: dimension,
    cx, cz,
    blocks: s.blocks,
    light: s.light,
    heightmap: s.heightmap,
    biomes: s.biomes,
    blockEntities: blockEntitiesToArray(s.blockEntities),
    generated: bool(s.generated),
    populated: bool(s.populated),
    lit: bool(s.lit),
    saved: Date.now(),
    v: SAVE_VERSION,
  };
}

/** Map<localIndex, obj> -> [[index, plainObj], ...] (clone-safe). */
function blockEntitiesToArray(be) {
  const out = [];
  if (!be) return out;
  const push = (k, v) => {
    const c = toCloneable(v);
    if (c !== undefined) out.push([Number(k) | 0, c]);
  };
  if (be instanceof Map) { for (const [k, v] of be) push(k, v); }
  else if (Array.isArray(be)) { for (const pair of be) if (Array.isArray(pair)) push(pair[0], pair[1]); }
  else if (typeof be === 'object') { for (const k of Object.keys(be)) push(k, be[k]); }
  return out;
}

/** Approximate on-disk size of a chunk record, for the stats readout. */
function chunkBytes(rec) {
  return (rec.blocks?.byteLength || 0) + (rec.light?.byteLength || 0) +
         (rec.biomes?.byteLength || 0) + (rec.heightmap?.byteLength || 0) + 256;
}

/** Fills in defaults so old/partial metadata still renders in the world list. */
function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  return {
    ...meta,
    name: str(meta.name, 'World'),
    seed: num(meta.seed, 0),
    created: num(meta.created, Date.now()),
    lastPlayed: num(meta.lastPlayed, num(meta.created, Date.now())),
    played: num(meta.played, 0),
    mode: str(meta.mode, GAMEMODE.SURVIVAL),
    difficulty: num(meta.difficulty, DIFFICULTY.NORMAL),
    dimension: str(meta.dimension, DIM_OVERWORLD),
    time: num(meta.time, 0),
    totalTime: num(meta.totalTime, 0),
    weather: meta.weather || { rain: 0, thunder: 0, rainTicks: 0, thunderTicks: 0 },
    spawnPoint: capturePoint(meta.spawnPoint, { x: 0, y: 64, z: 0 }),
    dimensions: meta.dimensions && typeof meta.dimensions === 'object' ? meta.dimensions : {},
    thumbnail: typeof meta.thumbnail === 'string' ? meta.thumbnail : null,
    version: num(meta.version, SAVE_VERSION),
  };
}

// ---------------------------------------------------------------------------
// SaveManager
// ---------------------------------------------------------------------------

/**
 * Owns the IndexedDB connection and every read/write the game performs.
 * One instance is enough; `getSaveManager()` returns a shared one.
 */
export class SaveManager {
  constructor() {
    /** @type {IDBBackend|MemoryBackend|null} */
    this.backend = null;
    this.ready = false;
    this.available = false;          // true only when real IndexedDB is in use
    this.backendKind = 'none';
    this.autoSaveEnabled = true;
    this.autoSaveInterval = AUTOSAVE_INTERVAL_MS;
    this.saving = false;
    this.lastSaveAt = 0;             // wall-clock ms of the last successful save
    this.lastError = null;
    this.quotaExceeded = false;
    this.playTimeMs = 0;             // unpaused play time this session

    /** Dirty chunks reported through markChunkModified, keyed 'dim|cx,cz'. */
    this._pending = new Map();
    this._initPromise = null;
    this._inFlight = null;
    this._sinceSaveMs = 0;
    this._playSinceSave = 0;
    this._lastTickAt = 0;
    this._lastThumbAt = 0;
    this._consecutiveErrors = 0;
    this._hooked = false;

    this.stats = {
      saves: 0, chunkWrites: 0, chunkReads: 0, bytesWritten: 0,
      lastSaveMs: 0, lastChunkCount: 0, errors: 0,
    };

    if (!activeManager) activeManager = this;
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Opens the database. Safe to call repeatedly; the same promise is reused.
   * Never rejects - on failure it falls back to an in-memory store.
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      const db = await openDatabase();
      this.backend = new IDBBackend(db);
      this.available = true;
      this.backendKind = 'indexeddb';
      // Another tab upgrading the schema would block us; drop the handle.
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        this._switchToMemory('another tab upgraded the database');
      };
      db.onclose = () => { this._switchToMemory('the database connection closed'); };
    } catch (e) {
      this.lastError = e;
      this._switchToMemory(e && e.message ? e.message : String(e));
    }
    this.ready = true;
    this._lastTickAt = Date.now();
    this._installLifecycleHooks();
    return this;
  }

  /** Graceful degradation: keep playing, just without durable storage. */
  _switchToMemory(reason) {
    if (this.backend instanceof MemoryBackend) return;
    const old = this.backend;
    this.backend = new MemoryBackend();
    this.available = false;
    this.backendKind = 'memory';
    if (old && old !== this.backend) { try { old.close(); } catch { /* ignore */ } }
    warnOnce('no-idb',
      `IndexedDB unavailable (${reason}). Worlds will be kept in memory only and lost when this tab closes.`);
  }

  /** Ensures init() ran and returns the live backend. */
  async _ensure() {
    if (!this.ready) await this.init();
    if (!this.backend) this._switchToMemory('no backend');
    return this.backend;
  }

  /**
   * Records a failed operation and degrades the backend if it keeps failing.
   * `blameStorage` is false for failures caused by bad user input (a corrupt
   * import file, say) - those must never cost us a working database.
   */
  _fail(op, err, blameStorage = true) {
    this.lastError = err;
    this.stats.errors++;
    const name = err && err.name ? err.name : '';
    if (name === 'QuotaExceededError' || /quota/i.test(String(err && err.message))) {
      this.quotaExceeded = true;
      warnOnce('quota', 'storage quota exceeded - some data could not be written');
    }
    warnOnce('op-' + op, `${op} failed`, err);
    if (!blameStorage) return null;
    this._consecutiveErrors++;
    if (this._consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && this.available) {
      this._switchToMemory('repeated write failures');
    }
    return null;
  }

  _ok() { this._consecutiveErrors = 0; }

  /** Flush the world when the tab is hidden or unloaded. */
  _installLifecycleHooks() {
    if (this._hooked) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    this._hooked = true;
    const flush = () => {
      try {
        if (!this.autoSaveEnabled || this.saving) return;
        if (!Game.world || !Game.worldName) return;
        this.saveWorld(Game, Game.worldName).catch(() => {});
      } catch { /* never throw out of a lifecycle handler */ }
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  /** Closes the database handle. The manager can be re-init()ed afterwards. */
  close() {
    try { this.backend?.close(); } catch { /* ignore */ }
    this.backend = null;
    this.ready = false;
    this._initPromise = null;
  }

  // -- world metadata --------------------------------------------------------

  /**
   * All saved worlds, newest first.
   * @returns {Promise<Array<{name,seed,created,played,mode,thumbnail}>>}
   */
  async listWorlds() {
    try {
      const backend = await this._ensure();
      const rows = await backend.getAll(STORE_WORLDS);
      const out = [];
      for (const r of rows) { const m = normalizeMeta(r); if (m) out.push(m); }
      out.sort((a, b) => b.lastPlayed - a.lastPlayed);
      this._ok();
      return out;
    } catch (e) {
      this._fail('listWorlds', e);
      return [];
    }
  }

  /** Metadata for one world, or null. */
  async getWorldMeta(name) {
    try {
      const backend = await this._ensure();
      return normalizeMeta(await backend.get(STORE_WORLDS, String(name)));
    } catch (e) {
      this._fail('getWorldMeta', e);
      return null;
    }
  }

  /** True when a world with this name is already stored. */
  async worldExists(name) {
    return (await this.getWorldMeta(name)) !== null;
  }

  /** 'New World' -> 'New World (2)' when the name is taken. */
  async uniqueWorldName(base) {
    const clean = str(base, 'New World').trim() || 'New World';
    if (!(await this.worldExists(clean))) return clean;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${clean} (${i})`;
      if (!(await this.worldExists(candidate))) return candidate;
    }
    return `${clean} ${Date.now()}`;
  }

  /**
   * Writes the metadata row for a brand-new world before it is played.
   * @returns {Promise<object|null>} the stored metadata
   */
  async createWorld(name, opts = {}) {
    try {
      const backend = await this._ensure();
      const meta = normalizeMeta({
        name: str(name, 'New World'),
        seed: num(opts.seed, 0),
        created: Date.now(),
        lastPlayed: Date.now(),
        played: 0,
        mode: str(opts.mode, GAMEMODE.SURVIVAL),
        difficulty: num(opts.difficulty, DIFFICULTY.NORMAL),
        dimension: str(opts.dimension, DIM_OVERWORLD),
        generator: str(opts.generator, 'default'),
        cheats: opts.cheats !== false,
        time: num(opts.time, 0),
        spawnPoint: capturePoint(opts.spawnPoint, { x: 0, y: 64, z: 0 }),
        version: SAVE_VERSION,
      });
      await backend.put(STORE_WORLDS, meta);
      this._ok();
      return meta;
    } catch (e) {
      this._fail('createWorld', e);
      return null;
    }
  }

  /** Deletes a world plus its player row and every stored chunk. */
  async deleteWorld(name) {
    const key = String(name);
    try {
      const backend = await this._ensure();
      await backend.delete(STORE_WORLDS, key);
      await backend.delete(STORE_PLAYERS, key);
      await backend.deleteRange(STORE_CHUNKS, worldChunkRange(key));
      this._pending.clear();
      this._ok();
      return true;
    } catch (e) {
      this._fail('deleteWorld', e);
      return false;
    }
  }

  /** Copies a world (metadata, player and chunks) under a new name. */
  async renameWorld(from, to) {
    try {
      const backend = await this._ensure();
      const meta = await backend.get(STORE_WORLDS, String(from));
      if (!meta) return false;
      const target = await this.uniqueWorldName(to);
      meta.name = target;
      await backend.put(STORE_WORLDS, meta);
      const player = await backend.get(STORE_PLAYERS, String(from));
      if (player) { player.world = target; await backend.put(STORE_PLAYERS, player); }
      const chunks = await backend.getAll(STORE_CHUNKS, worldChunkRange(String(from)));
      for (let i = 0; i < chunks.length; i += CHUNKS_PER_TRANSACTION) {
        const batch = chunks.slice(i, i + CHUNKS_PER_TRANSACTION).map((c) => ({
          ...c, world: target, wd: `${target}|${c.dim}`, key: chunkRecordKey(target, c.dim, c.cx, c.cz),
        }));
        await backend.putMany(STORE_CHUNKS, batch);
        await yieldToHost();
      }
      await this.deleteWorld(from);
      this._ok();
      return target;
    } catch (e) {
      this._fail('renameWorld', e);
      return false;
    }
  }

  // -- saving ----------------------------------------------------------------

  /**
   * Persists everything about the running game: seed, name, dimension, time,
   * weather, spawn point, game mode, difficulty, the player's full state and
   * every dirty chunk in every loaded dimension.
   *
   * Concurrent calls coalesce onto the in-flight save.
   * @returns {Promise<{ok:boolean,name:string,chunks:number,ms:number,error?:any}>}
   */
  async saveWorld(game, name) {
    if (this._inFlight) return this._inFlight;
    const promise = this._runSave(game || Game, name);
    this._inFlight = promise;
    try {
      return await promise;
    } finally {
      this._inFlight = null;
    }
  }

  async _runSave(game, name) {
    const started = monotonic();
    const worldName = str(name, str(game?.worldName, 'New World')) || 'New World';
    this.saving = true;
    let written = 0;
    try {
      const backend = await this._ensure();
      const prev = await backend.get(STORE_WORLDS, worldName);

      // --- metadata ---------------------------------------------------------
      const active = game?.world;
      const meta = normalizeMeta({
        ...(prev || {}),
        name: worldName,
        seed: num(game?.seed, num(active?.seed, num(prev?.seed, 0))),
        created: num(prev?.created, Date.now()),
        lastPlayed: Date.now(),
        played: num(prev?.played, 0) + Math.round(this._playSinceSave),
        mode: str(game?.mode, str(prev?.mode, GAMEMODE.SURVIVAL)),
        difficulty: num(game?.difficulty, num(prev?.difficulty, DIFFICULTY.NORMAL)),
        dimension: str(game?.dimension, str(active?.dimension, DIM_OVERWORLD)),
        cheats: game?.cheats !== false,
        time: num(active?.time, num(prev?.time, 0)),
        totalTime: num(active?.totalTime, num(prev?.totalTime, 0)),
        weather: captureWeather(active),
        spawnPoint: capturePoint(active?.spawnPoint, capturePoint(prev?.spawnPoint, { x: 0, y: 64, z: 0 })),
        dimensions: { ...(prev?.dimensions || {}), ...captureDimensions(game) },
        thumbnail: this._maybeThumbnail(game, prev),
        version: SAVE_VERSION,
      });

      // --- player -----------------------------------------------------------
      const player = capturePlayer(game, worldName);

      await backend.put(STORE_WORLDS, meta);
      await backend.put(STORE_PLAYERS, player);
      this._playSinceSave = 0;   // banked into meta.played, safe to reset now

      // --- dirty chunks, in small batches with a yield between them ---------
      const dirty = this._collectDirty(game);
      for (let i = 0; i < dirty.length; i += CHUNKS_PER_TRANSACTION) {
        const slice = dirty.slice(i, i + CHUNKS_PER_TRANSACTION);
        const records = [];
        for (const { dim, chunk } of slice) {
          const rec = chunkRecord(worldName, dim, chunk);
          records.push(rec);
          this.stats.bytesWritten += chunkBytes(rec);
        }
        // Lower the flags *before* handing the batch over: putMany's structured
        // clone happens synchronously inside it, and no game code can run
        // between here and there. An edit made while the transaction is still
        // committing therefore re-raises the flag and is caught next pass,
        // instead of being silently swallowed.
        for (const { dim, chunk } of slice) {
          chunk.modified = false;
          this._pending.delete(`${dim}|${chunk.cx},${chunk.cz}`);
        }
        try {
          await backend.putMany(STORE_CHUNKS, records);
        } catch (err) {
          // The batch never landed - put the work back on the queue.
          for (const { dim, chunk } of slice) {
            chunk.modified = true;
            this._pending.set(`${dim}|${chunk.cx},${chunk.cz}`, { dim, chunk });
          }
          throw err;
        }
        written += slice.length;
        if (i + CHUNKS_PER_TRANSACTION < dirty.length) await yieldToHost();
      }

      if (written > 0 || !prev) {
        meta.chunkCount = await backend.count(STORE_CHUNKS, worldChunkRange(worldName));
        await backend.put(STORE_WORLDS, meta);
      }

      const ms = monotonic() - started;
      this.stats.saves++;
      this.stats.chunkWrites += written;
      this.stats.lastSaveMs = ms;
      this.stats.lastChunkCount = written;
      this.lastSaveAt = Date.now();
      this._sinceSaveMs = 0;
      this._ok();
      return { ok: true, name: worldName, chunks: written, ms };
    } catch (e) {
      this._fail('saveWorld', e);
      this._sinceSaveMs = 0;   // do not hammer a broken backend every frame
      return { ok: false, name: worldName, chunks: written, ms: monotonic() - started, error: e };
    } finally {
      this.saving = false;
    }
  }

  /**
   * Gathers every chunk that needs writing: the loaded ones whose `modified`
   * flag is up, plus anything markChunkModified() saw that has since been
   * unloaded.
   * @returns {Array<{dim:string, chunk:object}>}
   */
  _collectDirty(game) {
    const out = [];
    const seen = new Set();
    for (const [dim, world] of worldEntries(game)) {
      const chunks = world?.chunks;
      if (!chunks || typeof chunks.values !== 'function') continue;
      for (const chunk of chunks.values()) {
        if (!chunk || !chunk.modified) continue;
        const key = `${dim}|${chunk.cx},${chunk.cz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ dim, chunk });
      }
    }
    for (const [key, entry] of this._pending) {
      if (seen.has(key) || !entry?.chunk) continue;
      seen.add(key);
      out.push({ dim: entry.dim, chunk: entry.chunk });
    }
    return out;
  }

  /** Grabs a fresh thumbnail at most once a minute; reuses the old one else. */
  _maybeThumbnail(game, prev) {
    const now = Date.now();
    const old = typeof prev?.thumbnail === 'string' ? prev.thumbnail : null;
    if (old && now - this._lastThumbAt < THUMBNAIL_INTERVAL_MS) return old;
    const shot = this.captureThumbnail(game);
    if (shot) { this._lastThumbAt = now; return shot; }
    return old;
  }

  /**
   * Grabs a small JPEG data URL of the current frame for the world list.
   * Returns null outside a browser or when the canvas cannot be read.
   */
  captureThumbnail(game, w = 192, h = 108) {
    try {
      if (typeof document === 'undefined') return null;
      const src = (game || Game)?.renderer?.domElement;
      if (!src || !src.width || !src.height) return null;
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) return null;
      // cover-fit the framebuffer into the thumbnail
      const scale = Math.max(w / src.width, h / src.height);
      const sw = w / scale, sh = h / scale;
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
      return out.toDataURL('image/jpeg', 0.6);
    } catch {
      return null;   // tainted or lost context - a missing thumbnail is fine
    }
  }

  // -- loading ---------------------------------------------------------------

  /**
   * Reads a world back.
   * @returns {Promise<object|null>} { name, seed, meta, player, ... } or null
   */
  async loadWorld(name) {
    const key = String(name);
    try {
      const backend = await this._ensure();
      const meta = normalizeMeta(await backend.get(STORE_WORLDS, key));
      if (!meta) return null;
      const player = (await backend.get(STORE_PLAYERS, key)) || null;
      this._pending.clear();
      this._sinceSaveMs = 0;
      this._playSinceSave = 0;
      this._lastTickAt = Date.now();
      this._ok();
      return {
        name: meta.name,
        meta,
        seed: meta.seed,
        created: meta.created,
        lastPlayed: meta.lastPlayed,
        played: meta.played,
        mode: meta.mode,
        difficulty: meta.difficulty,
        dimension: meta.dimension,
        time: meta.time,
        totalTime: meta.totalTime,
        weather: meta.weather,
        spawnPoint: meta.spawnPoint,
        dimensions: meta.dimensions,
        version: meta.version,
        player,
      };
    } catch (e) {
      this._fail('loadWorld', e);
      return null;
    }
  }

  /** Just the player row for a world, or null. */
  async loadPlayer(name) {
    try {
      const backend = await this._ensure();
      return (await backend.get(STORE_PLAYERS, String(name))) || null;
    } catch (e) {
      this._fail('loadPlayer', e);
      return null;
    }
  }

  // -- chunks ----------------------------------------------------------------

  /**
   * Raises the dirty flag so the next save pass writes this chunk. Cheap
   * enough to call from setBlock; untouched chunks are never persisted.
   */
  markChunkModified(chunk) {
    if (!chunk || typeof chunk !== 'object') return false;
    chunk.modified = true;
    const dim = str(chunk.world?.dimension, str(Game.dimension, DIM_OVERWORLD));
    const key = `${dim}|${chunk.cx},${chunk.cz}`;
    if (!this._pending.has(key)) {
      if (this._pending.size >= PENDING_LIMIT) {
        // Bounded side table: the oldest entry stays flagged on the chunk
        // itself, so a loaded chunk is still picked up by the scan.
        const oldest = this._pending.keys().next();
        if (!oldest.done) this._pending.delete(oldest.value);
      }
      this._pending.set(key, { dim, chunk });
    }
    return true;
  }

  /** Writes one chunk immediately. Returns true on success. */
  async saveChunk(worldName, chunk, dimension) {
    if (!chunk) return false;
    try {
      const backend = await this._ensure();
      const dim = str(dimension, str(chunk.world?.dimension, str(Game.dimension, DIM_OVERWORLD)));
      const rec = chunkRecord(String(worldName), dim, chunk);
      await backend.put(STORE_CHUNKS, rec);
      chunk.modified = false;
      this._pending.delete(`${dim}|${chunk.cx},${chunk.cz}`);
      this.stats.chunkWrites++;
      this.stats.bytesWritten += chunkBytes(rec);
      this._ok();
      return true;
    } catch (e) {
      this._fail('saveChunk', e);
      return false;
    }
  }

  /**
   * Reads one saved chunk back.
   * @returns {Promise<Chunk|null>} a hydrated Chunk, or null when unsaved
   */
  async loadChunk(worldName, cx, cz, dim = DIM_OVERWORLD, world = null) {
    const rec = await this.loadChunkRecord(worldName, cx, cz, dim);
    if (!rec) return null;
    try {
      const chunk = Chunk.deserialize(rec, world);
      chunk.modified = false;
      return chunk;
    } catch (e) {
      this._fail('deserializeChunk', e, false);
      return null;
    }
  }

  /** The raw stored record for a chunk (typed arrays intact), or null. */
  async loadChunkRecord(worldName, cx, cz, dim = DIM_OVERWORLD) {
    try {
      const backend = await this._ensure();
      const rec = await backend.get(STORE_CHUNKS, chunkRecordKey(String(worldName), str(dim, DIM_OVERWORLD), cx, cz));
      if (rec) this.stats.chunkReads++;
      this._ok();
      return rec || null;
    } catch (e) {
      this._fail('loadChunk', e);
      return null;
    }
  }

  /** Number of chunks stored for a world (optionally one dimension). */
  async countChunks(worldName, dim = null) {
    try {
      const backend = await this._ensure();
      return await backend.count(STORE_CHUNKS, worldChunkRange(String(worldName), dim));
    } catch (e) {
      this._fail('countChunks', e);
      return 0;
    }
  }

  /** Every saved chunk key for a world, as 'cx,cz' strings. */
  async savedChunkKeys(worldName, dim = DIM_OVERWORLD) {
    try {
      const backend = await this._ensure();
      const keys = await backend.getAllKeys(STORE_CHUNKS, worldChunkRange(String(worldName), dim));
      return keys.map((k) => String(k).slice(String(k).lastIndexOf('|') + 1));
    } catch (e) {
      this._fail('savedChunkKeys', e);
      return [];
    }
  }

  // -- autosave --------------------------------------------------------------

  /**
   * Call once per frame or tick. Counts unpaused play time and kicks off a
   * save every 30 seconds. Synchronous and allocation-free on the common
   * path: it never awaits, so it cannot stall a frame.
   * @returns {boolean} true when this call started a save
   */
  autoSaveTick(game) {
    try {
      const g = game || Game;
      const now = Date.now();
      const last = this._lastTickAt || now;
      this._lastTickAt = now;
      // Clamp so a backgrounded tab does not bank half an hour of "play".
      const delta = Math.min(Math.max(now - last, 0), 1000);
      if (g?.paused) return false;

      this.playTimeMs += delta;
      this._playSinceSave += delta;
      this._sinceSaveMs += delta;

      if (!this.autoSaveEnabled) return false;
      if (this.saving || this._inFlight) return false;
      if (this._sinceSaveMs < this.autoSaveInterval) return false;
      if (!g?.world || !g?.worldName) { this._sinceSaveMs = 0; return false; }

      this._sinceSaveMs = 0;
      // Fire and forget - the save yields between chunk batches on its own.
      this.saveWorld(g, g.worldName).catch(() => {});
      return true;
    } catch (e) {
      this._fail('autoSaveTick', e, false);
      return false;
    }
  }

  /** Forces a save now, ignoring the timer. Resolves with the save result. */
  async flush(game, name) {
    const g = game || Game;
    return this.saveWorld(g, str(name, str(g?.worldName, 'New World')));
  }

  /** Restarts the autosave countdown (after loading a world, say). */
  resetAutoSaveTimer() {
    this._sinceSaveMs = 0;
    this._playSinceSave = 0;
    this._lastTickAt = Date.now();
  }

  // -- settings store --------------------------------------------------------

  /** Reads a value from the settings store. */
  async getSetting(key, fallback = null) {
    try {
      const backend = await this._ensure();
      const row = await backend.get(STORE_SETTINGS, String(key));
      return row && 'value' in row ? row.value : fallback;
    } catch (e) {
      this._fail('getSetting', e);
      return fallback;
    }
  }

  /** Writes a value into the settings store. */
  async setSetting(key, value) {
    try {
      const backend = await this._ensure();
      await backend.put(STORE_SETTINGS, { key: String(key), value: toCloneable(value), saved: Date.now() });
      this._ok();
      return true;
    } catch (e) {
      this._fail('setSetting', e);
      return false;
    }
  }

  /** Every settings row as a plain object. */
  async allSettings() {
    try {
      const backend = await this._ensure();
      const rows = await backend.getAll(STORE_SETTINGS);
      const out = {};
      for (const r of rows) if (r && r.key !== undefined) out[r.key] = r.value;
      return out;
    } catch (e) {
      this._fail('allSettings', e);
      return {};
    }
  }

  /**
   * Mirrors the options blob into IndexedDB as a backup of the canonical
   * localStorage copy owned by core/settings.js.
   */
  async backupSettings(values) {
    let payload = values;
    if (payload === undefined && typeof localStorage !== 'undefined') {
      try { payload = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null'); } catch { payload = null; }
    }
    if (payload == null) return false;
    return this.setSetting(SETTINGS_STORAGE_KEY, payload);
  }

  // -- import / export -------------------------------------------------------

  /**
   * Packs a whole world into a JSON Blob suitable for a download link.
   * Typed arrays travel as base64. Returns null when the world is unknown.
   * @returns {Promise<Blob|string|null>} a Blob (or raw JSON where Blob is absent)
   */
  async exportWorld(name) {
    try {
      const backend = await this._ensure();
      const key = String(name);
      const meta = normalizeMeta(await backend.get(STORE_WORLDS, key));
      if (!meta) return null;
      const player = (await backend.get(STORE_PLAYERS, key)) || null;
      const chunks = [];
      for (const dim of DIMENSIONS) {
        const rows = await backend.getAll(STORE_CHUNKS, worldChunkRange(key, dim));
        for (const r of rows) {
          chunks.push({
            dim: str(r.dim, dim), cx: r.cx | 0, cz: r.cz | 0,
            blocks: encodeValue(r.blocks), light: encodeValue(r.light),
            heightmap: encodeValue(r.heightmap), biomes: encodeValue(r.biomes),
            blockEntities: encodeValue(r.blockEntities || []),
            generated: !!r.generated, populated: !!r.populated, lit: !!r.lit,
          });
        }
        await yieldToHost();
      }
      // Anything stored under a non-standard dimension name still gets out.
      const all = await backend.getAll(STORE_CHUNKS, worldChunkRange(key));
      if (all.length !== chunks.length) {
        const known = new Set(chunks.map((c) => `${c.dim}|${c.cx},${c.cz}`));
        for (const r of all) {
          const id = `${r.dim}|${r.cx},${r.cz}`;
          if (known.has(id)) continue;
          chunks.push({
            dim: str(r.dim, DIM_OVERWORLD), cx: r.cx | 0, cz: r.cz | 0,
            blocks: encodeValue(r.blocks), light: encodeValue(r.light),
            heightmap: encodeValue(r.heightmap), biomes: encodeValue(r.biomes),
            blockEntities: encodeValue(r.blockEntities || []),
            generated: !!r.generated, populated: !!r.populated, lit: !!r.lit,
          });
        }
      }
      const payload = {
        format: SAVE_FORMAT,
        version: SAVE_VERSION,
        exported: new Date().toISOString(),
        meta: encodeValue(meta),
        player: encodeValue(player),
        chunks,
      };
      const json = JSON.stringify(payload);
      this._ok();
      if (typeof Blob === 'undefined') return json;
      return new Blob([json], { type: 'application/json' });
    } catch (e) {
      this._fail('exportWorld', e);
      return null;
    }
  }

  /**
   * Restores a world from an exported blob. Accepts a Blob/File, a JSON
   * string, an ArrayBuffer or an already-parsed object. The world is stored
   * under a fresh name when the original one is taken.
   * @returns {Promise<{ok:boolean,name?:string,chunks?:number,error?:any}>}
   */
  async importWorld(blob) {
    try {
      const backend = await this._ensure();
      const payload = await parseImportPayload(blob);
      if (!payload || typeof payload !== 'object') throw new Error('not a minecraft67 world file');
      if (payload.format && payload.format !== SAVE_FORMAT) throw new Error(`unknown save format "${payload.format}"`);

      const meta = normalizeMeta(decodeValue(payload.meta) || {});
      if (!meta) throw new Error('world file has no metadata');
      const target = await this.uniqueWorldName(meta.name);
      meta.name = target;
      meta.lastPlayed = Date.now();
      meta.imported = Date.now();
      await backend.put(STORE_WORLDS, meta);

      const player = decodeValue(payload.player);
      if (player && typeof player === 'object') {
        player.world = target;
        await backend.put(STORE_PLAYERS, player);
      }

      const list = Array.isArray(payload.chunks) ? payload.chunks : [];
      let written = 0;
      for (let i = 0; i < list.length; i += CHUNKS_PER_TRANSACTION) {
        const records = [];
        for (const raw of list.slice(i, i + CHUNKS_PER_TRANSACTION)) {
          if (!raw) continue;
          const dim = str(raw.dim, DIM_OVERWORLD);
          const cx = raw.cx | 0, cz = raw.cz | 0;
          records.push({
            key: chunkRecordKey(target, dim, cx, cz),
            world: target, wd: `${target}|${dim}`, dim, cx, cz,
            blocks: decodeValue(raw.blocks),
            light: decodeValue(raw.light),
            heightmap: decodeValue(raw.heightmap),
            biomes: decodeValue(raw.biomes),
            blockEntities: decodeValue(raw.blockEntities) || [],
            generated: !!raw.generated, populated: !!raw.populated, lit: !!raw.lit,
            saved: Date.now(), v: SAVE_VERSION,
          });
        }
        if (records.length) {
          await backend.putMany(STORE_CHUNKS, records);
          written += records.length;
        }
        await yieldToHost();
      }

      meta.chunkCount = written;
      await backend.put(STORE_WORLDS, meta);
      this._ok();
      return { ok: true, name: target, chunks: written };
    } catch (e) {
      this._fail('importWorld', e, false);
      return { ok: false, error: e, message: e && e.message ? e.message : String(e) };
    }
  }

  // -- storage quota ---------------------------------------------------------

  /**
   * navigator.storage.estimate() wrapper with friendly extras.
   * @returns {Promise<{supported,usage,quota,available,percent,persisted,backend}>}
   */
  async quotaInfo() {
    const info = {
      supported: false, backend: this.backendKind,
      usage: 0, quota: 0, available: 0, percent: 0,
      usageMB: 0, quotaMB: 0, persisted: false, details: null,
    };
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      if (nav && nav.storage && typeof nav.storage.estimate === 'function') {
        const est = await nav.storage.estimate();
        info.supported = true;
        info.usage = num(est?.usage, 0);
        info.quota = num(est?.quota, 0);
        info.available = Math.max(0, info.quota - info.usage);
        info.percent = info.quota > 0 ? (info.usage / info.quota) * 100 : 0;
        if (est && est.usageDetails) info.details = { ...est.usageDetails };
      }
      if (nav && nav.storage && typeof nav.storage.persisted === 'function') {
        try { info.persisted = !!(await nav.storage.persisted()); } catch { /* not permitted */ }
      }
    } catch (e) {
      warnOnce('quota-info', 'storage estimate failed', e);
    }
    info.usageMB = Math.round((info.usage / 1048576) * 100) / 100;
    info.quotaMB = Math.round((info.quota / 1048576) * 100) / 100;
    return info;
  }

  /** Asks the browser not to evict our worlds. Resolves to the granted flag. */
  async requestPersistence() {
    try {
      const nav = typeof navigator !== 'undefined' ? navigator : null;
      if (nav && nav.storage && typeof nav.storage.persist === 'function') return !!(await nav.storage.persist());
    } catch { /* user or browser said no */ }
    return false;
  }

  /** Wipes every world. Used by the "reset game data" option. */
  async deleteEverything() {
    try {
      const backend = await this._ensure();
      for (const store of Object.keys(STORE_KEYPATHS)) await backend.clear(store);
      this._pending.clear();
      this._ok();
      return true;
    } catch (e) {
      this._fail('deleteEverything', e);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------

/** Turns a Blob/File/string/ArrayBuffer/object into a parsed payload object. */
async function parseImportPayload(input) {
  if (input == null) return null;
  if (typeof input === 'string') return JSON.parse(input);
  if (typeof Blob !== 'undefined' && input instanceof Blob) return JSON.parse(await input.text());
  if (input instanceof ArrayBuffer || isTypedArray(input)) {
    const bytes = input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let text;
    if (typeof TextDecoder === 'function') {
      text = new TextDecoder('utf-8').decode(bytes);
    } else {
      // Latin-1 fallback; exported files are ASCII-safe JSON in practice.
      text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return JSON.parse(text);
  }
  if (typeof input.text === 'function') return JSON.parse(await input.text());
  if (typeof input === 'object') return input;
  return null;
}

// ---------------------------------------------------------------------------
// Restore helpers - optional conveniences for the integrator
// ---------------------------------------------------------------------------

/**
 * Applies a saved player record onto a live Player. Missing fields are left
 * alone, so this is safe with partial or older saves.
 */
export function applyPlayerSave(player, data) {
  if (!player || !data || typeof data !== 'object') return false;
  const set = (key, value, min = -Infinity, max = Infinity) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      player[key] = value < min ? min : value > max ? max : value;
    }
  };
  set('x', data.x); set('y', data.y); set('z', data.z);
  player.px = player.x; player.py = player.y; player.pz = player.z;
  set('vx', data.vx); set('vy', data.vy); set('vz', data.vz);
  set('yaw', data.yaw); set('pitch', data.pitch); set('headYaw', data.headYaw);
  set('maxHealth', data.maxHealth, 1);
  set('health', data.health, 0, num(data.maxHealth, MAX_HEALTH));
  set('absorption', data.absorption, 0);
  set('hunger', data.hunger, 0, MAX_HUNGER);
  set('saturation', data.saturation, 0);
  set('exhaustion', data.exhaustion, 0);
  set('airSupply', data.airSupply, 0);
  set('fireTicks', data.fireTicks, 0);
  set('fallDistance', data.fallDistance, 0);
  set('xp', data.xp, 0);
  set('xpLevel', data.xpLevel, 0);
  set('xpProgress', data.xpProgress, 0, 1);
  set('selectedSlot', data.selectedSlot, 0, 8);
  if (typeof data.gameMode === 'string') player.gameMode = data.gameMode;
  if (typeof data.flying === 'boolean') player.flying = data.flying;
  if (typeof data.canFly === 'boolean') player.canFly = data.canFly;
  if (data.respawnPoint) player.respawnPoint = { ...data.respawnPoint };
  player.dead = false;

  if (player.inventory && data.inventory) {
    try {
      if (typeof player.inventory.load === 'function') player.inventory.load(data.inventory);
      else if (Array.isArray(data.inventory.slots) && typeof player.inventory.set === 'function') {
        for (let i = 0; i < data.inventory.slots.length; i++) player.inventory.set(i, data.inventory.slots[i] || null);
      }
    } catch (e) { warnOnce('inv-load', 'inventory.load() failed', e); }
    if (typeof player.inventory.selected === 'number') player.inventory.selected = num(data.selectedSlot, 0);
  }

  if (Array.isArray(data.effects) && typeof player.addEffect === 'function') {
    for (const eff of data.effects) {
      if (!eff || !eff.name) continue;
      try { player.addEffect(eff.name, num(eff.ticks, 0), num(eff.level, 0)); } catch { /* unknown effect */ }
    }
  }
  return true;
}

/** Applies saved time/weather/spawn onto a live World. */
export function applyWorldSave(world, save, dimension = null) {
  if (!world || !save) return false;
  const dim = dimension || world.dimension || DIM_OVERWORLD;
  const per = save.dimensions && save.dimensions[dim];
  const src = per || save;
  if (typeof src.time === 'number') world.time = src.time;
  if (typeof src.totalTime === 'number') world.totalTime = src.totalTime;
  if (src.weather && world.weather) {
    world.weather.rain = num(src.weather.rain);
    world.weather.thunder = num(src.weather.thunder);
    world.weather.rainTicks = num(src.weather.rainTicks);
    world.weather.thunderTicks = num(src.weather.thunderTicks);
  }
  if (src.spawnPoint) world.spawnPoint = { x: num(src.spawnPoint.x), y: num(src.spawnPoint.y, 64), z: num(src.spawnPoint.z) };
  return true;
}

// ---------------------------------------------------------------------------
// Shared instance + module-level conveniences
// ---------------------------------------------------------------------------

/**
 * The SaveManager the game is using: whatever main.js put on Game.save, else
 * the first one constructed, else a fresh one.
 */
export function getSaveManager() {
  const fromGame = Game.save;
  if (fromGame && typeof fromGame.saveWorld === 'function') return fromGame;
  if (!activeManager) activeManager = new SaveManager();
  return activeManager;
}

/** Convenience wrapper around getSaveManager().markChunkModified(). */
export function markChunkModified(chunk) {
  return getSaveManager().markChunkModified(chunk);
}

/** Convenience wrapper around getSaveManager().autoSaveTick(). */
export function autoSaveTick(game) {
  return getSaveManager().autoSaveTick(game);
}

/** Convenience wrapper: packs a saved world into a downloadable JSON Blob. */
export async function exportWorld(name) {
  return getSaveManager().exportWorld(name);
}

/** Convenience wrapper: restores a world from an exported blob. */
export async function importWorld(blob) {
  return getSaveManager().importWorld(blob);
}

/** Convenience wrapper around navigator.storage.estimate(). */
export async function quotaInfo() {
  return getSaveManager().quotaInfo();
}

/** Triggers a browser download for an exported world. No-op outside a browser. */
export async function downloadWorld(name, fileName) {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
    const blob = await exportWorld(name);
    if (!blob || typeof blob === 'string') return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = str(fileName, `${String(name).replace(/[^\w\-. ]+/g, '_')}.mc67.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof setTimeout === 'function') setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch (e) {
    warnOnce('download', 'world download failed', e);
    return false;
  }
}

export default SaveManager;
