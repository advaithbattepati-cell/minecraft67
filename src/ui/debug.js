// ============================================================================
// src/ui/debug.js - The F3 debug overlay.
//
// Two columns of text, a live frame-time graph, a chunk-state minimap and a
// red list of degraded subsystems.
//
// Cost policy: update() returns on its first line while the overlay is hidden,
// so F3-off is genuinely free. While visible the text is rebuilt at 10 Hz and
// the minimap at 4 Hz; only the frame graph touches a canvas every frame, and
// it writes a couple of hundred 2px rects into a strip a few pixels tall.
//
// Robustness policy: every cross-module read is either optional-chained or
// wrapped, because the whole point of this overlay is to stay readable when
// something else in the game is broken.
// ============================================================================
import { Game } from '../core/game.js';
import {
  CHUNK_X, CHUNK_Z, WORLD_HEIGHT, DAY_LENGTH_TICKS,
  DEFAULT_RENDER_DISTANCE, FACE_NAMES,
} from '../core/constants.js';
import { clamp, mod, formatTime, radToDeg, roman } from '../core/util.js';
import { getBlock, getTexture } from '../world/blocks.js';
import { getBiome } from '../world/biomes.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const GRAPH_SAMPLES = 1024;     // ring capacity for frame times (ms)
const GRAPH_BAR_CSS = 2;        // css px per bar in the frame-time graph
const STAT_WINDOW = 240;        // how many recent samples min/max/avg cover
const TEXT_INTERVAL = 0.1;      // seconds between text rebuilds
const MAP_INTERVAL = 0.25;      // seconds between minimap redraws
const COUNT_INTERVAL = 4.0;     // seconds between registry-count refreshes
const MEASURE_INTERVAL = 0.5;   // seconds between canvas size checks
const MAP_CSS_SIZE = 96;        // minimap edge, css px

const DIFFICULTY_NAMES = ['peaceful', 'easy', 'normal', 'hard'];
const MOON_BRIGHTNESS = [1.0, 0.75, 0.5, 0.25, 0.0, 0.25, 0.5, 0.75];

// Frame-time bar colours, classic Minecraft profiler palette.
const BAR_GOOD = '#63d13a';     // <= 16.7ms  (60 fps)
const BAR_OK = '#d1d13a';       // <= 33.3ms  (30 fps)
const BAR_WARN = '#d1873a';     // <= 50.0ms  (20 fps)
const BAR_BAD = '#d13a3a';      // worse

// Chunk minimap palette.
const MAP_EMPTY = 'rgba(255,255,255,0.05)';
const MAP_QUEUED = '#7a4fd0';
const MAP_GENERATING = '#6b4c31';
const MAP_POPULATING = '#a8712a';
const MAP_LIGHTING = '#d1b13a';
const MAP_READY = '#3a7bd1';
const MAP_DIRTY = '#d1873a';
const MAP_MESHED = '#63d13a';

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------
const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '--');
const int = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '--');

/** 512334 -> "512.3k", 2100000 -> "2.10M". Keeps counter lines narrow. */
function big(v) {
  if (!Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

/** Bytes -> megabytes, integer. */
const mb = (bytes) => Math.round((bytes || 0) / 1048576);

/** Right-pads so adjacent numbers line up in the monospaced column. */
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** Trims an over-long GPU / renderer string so it cannot blow out the column. */
function shorten(s, n = 44) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Compass name + the axis it points down, the way vanilla F3 phrases it. */
function facingFromYaw(yawDeg) {
  const y = mod(yawDeg + 180, 360) - 180;
  if (y >= -45 && y < 45) return { name: 'south', axis: 'Towards positive Z' };
  if (y >= 45 && y < 135) return { name: 'west', axis: 'Towards negative X' };
  if (y >= -135 && y < -45) return { name: 'east', axis: 'Towards positive X' };
  return { name: 'north', axis: 'Towards negative Z' };
}

/**
 * Vanilla's DifficultyInstance maths. Chunk inhabited time is not tracked by
 * this clone, so it reads as 0 unless a chunk happens to carry the field.
 */
function localDifficulty(world) {
  const diff = clamp(Math.round(Game.difficulty || 0), 0, 3);
  if (diff === 0 || !world) return { effective: 0, special: 0 };
  const total = Number(world.totalTime) || 0;
  const hard = diff === 3;
  const dayScale = clamp((total - 72000) / 2880000, 0, 1) * 0.25;
  let f = 0.75 + dayScale;

  let inhabited = 0;
  try {
    const p = Game.player;
    const c = p ? world.chunkAt(p.x, p.z) : null;
    inhabited = (c && Number(c.inhabitedTime)) || 0;
  } catch { inhabited = 0; }

  const phase = Math.floor(total / DAY_LENGTH_TICKS) & 7;
  let h = clamp(inhabited / 3600000, 0, 1) * (hard ? 1 : 0.75);
  h += clamp(MOON_BRIGHTNESS[phase] * 0.5, 0, dayScale);
  if (diff === 1) h *= 0.5;
  f += h;

  const effective = diff * f;
  const special = effective < 2 ? 0 : effective > 4 ? 1 : (effective - 2) / 2;
  return { effective, special };
}

/** A one-line summary of an entity's active status effects. */
function effectSummary(e) {
  const eff = e && e.effects;
  if (!eff || typeof eff.forEach !== 'function' || eff.size === 0) return 'none';
  const parts = [];
  try {
    eff.forEach((v, k) => {
      if (parts.length >= 4) return;
      const lvl = (v && v.level != null ? v.level : 0) + 1;
      const secs = v && v.ticks != null ? Math.ceil(v.ticks / 20) : 0;
      parts.push(`${k} ${roman(lvl)} (${secs}s)`);
    });
  } catch { return 'none'; }
  return parts.length ? parts.join(', ') : 'none';
}

/** Renders a block drop spec compactly for the definition summary. */
function dropsSummary(def) {
  const d = def && def.drops;
  if (d == null) return 'none';
  if (typeof d === 'function') return 'function';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    if (d.length === 0) return 'none';
    return d.slice(0, 3).map((e) => (typeof e === 'string' ? e : (e && e.item) || '?')).join(', ')
      + (d.length > 3 ? ` +${d.length - 3}` : '');
  }
  return String(d);
}

/** The `tex` field is either a name or a per-face map; describe it briefly. */
function texSummary(def) {
  const t = def && def.tex;
  if (t == null) return 'none';
  if (typeof t === 'string') return t;
  if (typeof t === 'object') {
    const keys = Object.keys(t);
    return keys.slice(0, 3).map((k) => `${k}=${t[k]}`).join(' ') + (keys.length > 3 ? ' …' : '');
  }
  return String(t);
}

// ---------------------------------------------------------------------------
// A recycling column of .debug-line divs.
//
// Rebuilding innerHTML at 10 Hz would churn the DOM for no reason; instead each
// line keeps its last text and class so an unchanged line costs one compare.
// ---------------------------------------------------------------------------
class Column {
  constructor(parent, className) {
    this.el = document.createElement('div');
    this.el.className = className;
    if (parent) parent.appendChild(this.el);
    this.lines = [];
    this.n = 0;
  }

  begin() { this.n = 0; }

  /** Appends one line. `cls` is '', 'warn', 'bad', 'good' or 'header'. */
  push(text, cls) {
    let el = this.lines[this.n];
    if (!el) {
      el = document.createElement('div');
      el._text = null;
      el._cls = null;
      this.lines.push(el);
      this.el.appendChild(el);
    }
    const full = cls ? 'debug-line ' + cls : 'debug-line';
    if (el._cls !== full) { el.className = full; el._cls = full; }
    // Trailing padding would widen the line's dark background for nothing.
    const s = (text == null ? '' : String(text)).replace(/ +$/, '');
    if (el._text !== s) { el.textContent = s; el._text = s; }
    if (el.hidden) el.hidden = false;
    this.n++;
  }

  /** A transparent spacer row. */
  gap() { this.push(' ', 'blank'); }

  end() {
    for (let i = this.n; i < this.lines.length; i++) {
      if (!this.lines[i].hidden) this.lines[i].hidden = true;
    }
  }
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------
/**
 * The F3 overlay. Construct once with the `#debug-layer` element; call
 * `toggle()` from the debug keybind and `update(dt)` every frame.
 */
export class DebugOverlay {
  /** @param {HTMLElement|null} root the #debug-layer element */
  constructor(root) {
    this.root = root || (typeof document !== 'undefined' ? document.createElement('div') : null);
    this._visible = false;

    this.left = this.root ? new Column(this.root, 'debug-left') : null;
    this.right = this.root ? new Column(this.root, 'debug-right') : null;

    // --- frame-time graph -------------------------------------------------
    this.graph = null;
    this._gctx = null;
    // --- chunk minimap ----------------------------------------------------
    this.map = null;
    this._mctx = null;

    if (this.root && typeof document !== 'undefined') {
      this.graph = document.createElement('canvas');
      this.graph.className = 'debug-graph';
      // A replaced element resolves `width:auto` to its intrinsic 300px even
      // when left+right are both 0, so the strip needs an explicit width.
      this.graph.style.cssText = 'display:block;width:100%;';
      this.root.appendChild(this.graph);
      try { this._gctx = this.graph.getContext('2d'); } catch { this._gctx = null; }

      this.map = document.createElement('canvas');
      this.map.className = 'debug-chunkmap';
      // No stylesheet rule owns this one, so it carries its own geometry. The
      // --gs custom property keeps it lined up with the graph strip below it.
      this.map.style.cssText =
        'position:absolute;left:var(--u2);bottom:calc(var(--gs) * 34px);'
        + `width:${MAP_CSS_SIZE}px;height:${MAP_CSS_SIZE}px;`
        + 'image-rendering:pixelated;pointer-events:none;'
        + 'background:rgba(0,0,0,0.55);box-shadow:0 0 0 1px rgba(0,0,0,0.65);';
      this.root.appendChild(this.map);
      try { this._mctx = this.map.getContext('2d'); } catch { this._mctx = null; }
    }

    // --- frame timing ring ------------------------------------------------
    this._samples = new Float32Array(GRAPH_SAMPLES);
    this._head = 0;
    this._filled = 0;
    this._minMs = 0;
    this._maxMs = 0;
    this._avgMs = 0;
    this._peakMs = 50;

    // --- timers -----------------------------------------------------------
    this._textTimer = 1e9;
    this._mapTimer = 1e9;
    this._countTimer = 1e9;
    this._measureTimer = 1e9;

    // --- caches -----------------------------------------------------------
    this._counts = null;
    this._glInfo = null;
    this._dpr = 1;

    this._setDisplay(false);
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------
  /** True while the overlay is on screen. */
  get visible() { return this._visible; }

  _setDisplay(on) {
    if (!this.root) return;
    this.root.style.display = on ? '' : 'none';
  }

  /**
   * Shows or hides the overlay. Pass a boolean to force a state.
   * @returns {boolean} the new visibility
   */
  toggle(force) {
    const next = force === undefined ? !this._visible : !!force;
    if (next === this._visible) return this._visible;
    this._visible = next;
    this._setDisplay(next);
    if (next) {
      // Start each session with clean timing stats and force a full rebuild.
      this._head = 0;
      this._filled = 0;
      this._peakMs = 50;
      this._textTimer = 1e9;
      this._mapTimer = 1e9;
      this._countTimer = 1e9;
      this._measureTimer = 1e9;
      this._counts = null;
    }
    return this._visible;
  }

  /** Shows the overlay. */
  show() { this.toggle(true); }
  /** Hides the overlay. */
  hide() { this.toggle(false); }
  /** Forces an immediate text + minimap rebuild on the next update. */
  refresh() { this._textTimer = 1e9; this._mapTimer = 1e9; this._counts = null; }

  // -------------------------------------------------------------------------
  // Per-frame driver
  // -------------------------------------------------------------------------
  /**
   * Called once per rendered frame from main.js.
   * @param {number} dt seconds since the previous frame
   */
  update(dt) {
    if (!this._visible || !this.root) return;   // hidden: cost nothing
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;

    this._sample(step);

    this._measureTimer += step;
    if (this._measureTimer >= MEASURE_INTERVAL) {
      this._measureTimer = 0;
      this._dpr = Math.min(window.devicePixelRatio || 1, 2);
      // On a short window the columns reach the bottom of the screen, so the
      // minimap steps aside rather than sitting on top of the text.
      if (this.map) {
        const room = window.innerHeight >= 560;
        const want = room ? '' : 'none';
        if (this.map.style.display !== want) this.map.style.display = want;
      }
      this._resize(this.graph);
      this._resize(this.map);
    }

    this._drawGraph();

    this._textTimer += step;
    if (this._textTimer >= TEXT_INTERVAL) {
      this._textTimer = 0;
      this._countTimer += TEXT_INTERVAL;
      this._computeStats();
      try { this._buildLeft(); } catch (e) { this._panic('left', e); }
      try { this._buildRight(); } catch (e) { this._panic('right', e); }
    }

    this._mapTimer += step;
    if (this._mapTimer >= MAP_INTERVAL) {
      this._mapTimer = 0;
      this._drawMap();
    }
  }

  /** Last-ditch reporting: a broken overlay must still say so, once. */
  _panic(where, err) {
    if (this._panicked === where) return;
    this._panicked = where;
    console.error('[debug:' + where + ']', err);
  }

  // -------------------------------------------------------------------------
  // Frame-time sampling
  // -------------------------------------------------------------------------
  _sample(step) {
    const ms = step > 0 ? step * 1000 : (Game.stats && Game.stats.frameMs) || 0;
    this._samples[this._head] = ms;
    this._head = (this._head + 1) % GRAPH_SAMPLES;
    if (this._filled < GRAPH_SAMPLES) this._filled++;
  }

  _computeStats() {
    const n = Math.min(this._filled, STAT_WINDOW);
    if (n === 0) { this._minMs = this._maxMs = this._avgMs = 0; return; }
    let lo = Infinity, hi = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const v = this._samples[(this._head - 1 - i + GRAPH_SAMPLES * 2) % GRAPH_SAMPLES];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    this._minMs = lo;
    this._maxMs = hi;
    this._avgMs = sum / n;
  }

  // -------------------------------------------------------------------------
  // Canvas plumbing
  // -------------------------------------------------------------------------
  /** Matches a canvas backing store to its CSS box. Returns true on change. */
  _resize(canvas) {
    if (!canvas) return false;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (cw <= 0 || ch <= 0) {
      // Hidden by a media query (the graph goes away on short viewports).
      // Zeroing the backing store makes the draw calls bail for free.
      if (canvas.width !== 0) { canvas.width = 0; canvas.height = 0; }
      return false;
    }
    const w = Math.max(1, Math.round(cw * this._dpr));
    const h = Math.max(1, Math.round(ch * this._dpr));
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w;
    canvas.height = h;
    return true;
  }

  // -------------------------------------------------------------------------
  // Frame-time graph
  // -------------------------------------------------------------------------
  _drawGraph() {
    const ctx = this._gctx, c = this.graph;
    if (!ctx || !c || c.width < 2 || c.height < 2) return;
    const w = c.width, h = c.height, dpr = this._dpr;
    const ring = this._samples, head = this._head;

    ctx.clearRect(0, 0, w, h);

    const bar = Math.max(1, Math.round(GRAPH_BAR_CSS * dpr));
    const bars = Math.max(1, Math.floor(w / bar));
    const count = Math.min(this._filled, bars);
    if (count === 0) return;

    // The vertical scale tracks the worst visible frame but decays slowly, so
    // one hitch does not make the whole strip jump.
    let peak = 33.4;
    for (let i = 0; i < count; i++) {
      const v = ring[(head - 1 - i + GRAPH_SAMPLES * 2) % GRAPH_SAMPLES];
      if (v > peak) peak = v;
    }
    this._peakMs = this._peakMs * 0.92 + peak * 0.08;
    const scale = Math.max(this._peakMs, peak, 20);

    // Reference lines at 60 fps and 30 fps.
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    for (let r = 0; r < 2; r++) {
      const ref = r === 0 ? 16.6667 : 33.3333;
      if (ref > scale) continue;
      const y = Math.round(h - (ref / scale) * h);
      ctx.fillRect(0, y, w, Math.max(1, Math.round(dpr * 0.5)));
    }

    // Bars are batched into one path per colour band: four fills a frame
    // instead of a thousand, so the graph barely perturbs what it measures.
    // Newest sample sits on the right, exactly like the vanilla profiler.
    const gap = bar > 2 ? 1 : 0;
    for (let band = 0; band < 4; band++) {
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const v = ring[(head - 1 - i + GRAPH_SAMPLES * 2) % GRAPH_SAMPLES];
        const b = v <= 16.6667 ? 0 : v <= 33.3333 ? 1 : v <= 50 ? 2 : 3;
        if (b !== band) continue;
        const x = w - (i + 1) * bar;
        if (x + bar <= 0) break;
        const bh = Math.max(1, Math.round((v / scale) * h));
        ctx.rect(x, h - bh, bar - gap, bh);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = band === 0 ? BAR_GOOD : band === 1 ? BAR_OK : band === 2 ? BAR_WARN : BAR_BAD;
      ctx.fill();
    }

    // Scale label. A plain system monospace face: never a webfont.
    const fs = Math.max(8, Math.round(7 * dpr));
    ctx.font = fs + 'px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    const label = scale.toFixed(0) + ' ms';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, ctx.measureText(label).width + 6 * dpr, fs + 3 * dpr);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText(label, 3 * dpr, dpr);
  }

  // -------------------------------------------------------------------------
  // Chunk-state minimap
  // -------------------------------------------------------------------------
  _drawMap() {
    const ctx = this._mctx, c = this.map;
    if (!ctx || !c || c.width < 2) return;
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    const world = Game.world;
    if (!world || !world.chunks) return;

    let rd = DEFAULT_RENDER_DISTANCE;
    try {
      const v = Game.chunkRenderer && Game.chunkRenderer.renderDistance;
      if (typeof v === 'number' && v > 0) rd = v;
      else {
        const s = Game.settings && Game.settings.get ? Game.settings.get('renderDistance') : null;
        if (typeof s === 'number' && s > 0) rd = s;
      }
    } catch { /* defaults are fine */ }

    const radius = clamp(Math.round(rd) + 1, 3, 12);
    const n = radius * 2 + 1;
    const cell = w / n;

    const p = Game.player;
    const pcx = Math.floor((p ? p.x : 0) / CHUNK_X);
    const pcz = Math.floor((p ? p.z : 0) / CHUNK_Z);

    const meshes = (Game.chunkRenderer && Game.chunkRenderer.chunks) || null;
    const pending = world._pendingMap || null;

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const key = (pcx + dx) + ',' + (pcz + dz);
        const chunk = world.chunks.get(key);
        let color;
        if (!chunk) {
          color = pending && pending.has && pending.has(key) ? MAP_QUEUED : MAP_EMPTY;
        } else if (!chunk.generated) {
          color = MAP_GENERATING;
        } else if (!chunk.populated) {
          color = MAP_POPULATING;
        } else if (!chunk.lit) {
          color = MAP_LIGHTING;
        } else {
          const meshed = meshes && meshes.has ? meshes.has(key) : false;
          color = !meshed ? MAP_READY : (chunk.dirty ? MAP_DIRTY : MAP_MESHED);
        }
        ctx.fillStyle = color;
        const x = Math.floor((dx + radius) * cell);
        const y = Math.floor((dz + radius) * cell);
        const x1 = Math.floor((dx + radius + 1) * cell);
        const y1 = Math.floor((dz + radius + 1) * cell);
        ctx.fillRect(x, y, Math.max(1, x1 - x - 1), Math.max(1, y1 - y - 1));
      }
    }

    // The render-distance square and the player's own chunk.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1, this._dpr);
    const inset = Math.max(0, Math.floor((radius - Math.round(rd)) * cell));
    ctx.strokeRect(inset + 0.5, inset + 0.5, w - inset * 2 - 1, h - inset * 2 - 1);

    ctx.strokeStyle = '#ffffff';
    const px = Math.floor(radius * cell);
    const py = Math.floor(radius * cell);
    ctx.strokeRect(px + 0.5, py + 0.5, Math.max(2, cell - 1), Math.max(2, cell - 1));

    // A north tick so the orientation is never ambiguous (-Z is up).
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(Math.floor(w / 2), 0, Math.max(1, this._dpr), Math.max(2, cell * 0.5));
  }

  // -------------------------------------------------------------------------
  // Left column: performance counters and player/world state
  // -------------------------------------------------------------------------
  _buildLeft() {
    const col = this.left;
    if (!col) return;
    col.begin();

    const st = Game.stats || {};
    const world = Game.world;
    const p = Game.player;

    col.push('minecraft67  (' + (Game.dimension || 'overworld') + ')', 'header');

    // --- frame timing -----------------------------------------------------
    const fps = st.fps || (this._avgMs > 0 ? 1000 / this._avgMs : 0);
    const fpsMin = this._maxMs > 0 ? 1000 / this._maxMs : 0;
    const fpsMax = this._minMs > 0 ? 1000 / this._minMs : 0;
    col.push(`${int(fps)} fps  (${int(fpsMin)}-${int(fpsMax)})`,
      fps >= 50 ? 'good' : fps >= 25 ? 'warn' : 'bad');
    col.push(`frame ${num(this._avgMs, 1)} ms  min ${num(this._minMs, 1)}  max ${num(this._maxMs, 1)}`
      + `  cpu ${num(st.frameMs, 1)}`);
    col.push(`tick ${pad(num(st.tickMs, 2), 6)} gen ${pad(num(st.genMs, 2), 6)} mesh ${num(st.meshMs, 2)} ms`);
    col.push(`draw ${pad(int(st.drawCalls), 6)} tris ${pad(big(st.triangles), 8)}`);
    col.push(`E: ${int(st.entities)} total, ${int(st.entitiesRendered)} rendered`);
    col.push(`C: ${int(st.chunksLoaded)} loaded, ${int(st.chunksRendered)} rendered, `
      + `${int(st.chunksQueued)} queued`);

    let meshed = 0;
    try { meshed = (Game.chunkRenderer && Game.chunkRenderer.chunks && Game.chunkRenderer.chunks.size) || 0; } catch { meshed = 0; }
    let pendingGen = 0;
    try { pendingGen = (world && world.pendingCount) || 0; } catch { pendingGen = 0; }
    col.push(`   ${meshed} chunk ${meshed === 1 ? 'mesh' : 'meshes'}, ${pendingGen} jobs pending`);

    col.gap();

    // --- position ---------------------------------------------------------
    if (p) {
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      const cx = bx >> 4, cz = bz >> 4;
      const lx = bx - (cx << 4), lz = bz - (cz << 4);
      const ly = by & 15;

      col.push(`XYZ: ${num(p.x, 3)} / ${num(p.y, 3)} / ${num(p.z, 3)}`);
      col.push(`Block: ${bx} ${by} ${bz}`);
      col.push(`Chunk: ${cx} ${by >> 4} ${cz}  [${lx} ${ly} ${lz} in chunk]`);

      const yawDeg = radToDeg(p.yaw || 0);
      const pitchDeg = radToDeg(p.pitch || 0);
      const f = facingFromYaw(yawDeg);
      const wrapped = mod(yawDeg + 180, 360) - 180;
      col.push(`Facing: ${f.name} (${f.axis})  (${num(wrapped, 1)} / ${num(pitchDeg, 1)})`);

      const vel = Math.hypot(p.vx || 0, p.vz || 0);
      col.push(`Vel: ${num(vel, 2)} m/s  vy ${num(p.vy, 2)}  ground ${p.onGround ? 'yes' : 'no'}`
        + (p.flying ? '  flying' : '') + (p.sprinting ? '  sprint' : '') + (p.sneaking ? '  sneak' : ''));
    } else {
      col.push('XYZ: -- / -- / --');
      col.push('Block: no player');
    }

    col.gap();

    // --- light / biome ----------------------------------------------------
    if (world && p) {
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      const feetY = clamp(by, 0, WORLD_HEIGHT - 1);
      let sky = 0, blockLight = 0, merged = 0;
      try {
        sky = world.getSkyLight(bx, feetY, bz) | 0;
        blockLight = world.getBlockLight(bx, feetY, bz) | 0;
        merged = world.getLight(bx, feetY, bz) | 0;
      } catch { /* unlit world */ }
      col.push(`Light: ${merged} (${sky} sky, ${blockLight} block)`);

      let biome = null;
      try {
        biome = typeof world.biomeAt === 'function' ? world.biomeAt(bx, bz) : getBiome(world.getBiome(bx, bz));
      } catch { biome = null; }
      if (biome) {
        col.push(`Biome: ${biome.name}  (${biome.category || '?'}, `
          + `temp ${num(biome.temperature, 2)}, rain ${num(biome.downfall, 2)})`);
      } else {
        col.push('Biome: unknown');
      }
    } else {
      col.push('Light: --');
      col.push('Biome: --');
    }

    // --- difficulty / time / weather --------------------------------------
    const day = world ? Math.floor((Number(world.totalTime) || 0) / DAY_LENGTH_TICKS) + 1 : 0;
    const ld = localDifficulty(world);
    col.push(`Local Difficulty: ${num(ld.effective, 2)} // ${num(ld.special, 2)}  (Day ${day})`);

    if (world) {
      const t = mod(Number(world.time) || 0, DAY_LENGTH_TICKS);
      let phase = 'day';
      try { phase = world.isDay && world.isDay() ? 'day' : 'night'; } catch { phase = 'day'; }
      let factor = 1;
      try { factor = world.skyLightFactor ? world.skyLightFactor() : 1; } catch { factor = 1; }
      col.push(`Time: ${formatTime(t)}  ${Math.floor(t)}/${DAY_LENGTH_TICKS} ticks  ${phase}`
        + `  sky ${num(factor, 2)}`);
      col.push(`Total ticks: ${Math.floor(Number(world.totalTime) || 0)}  session ${Game.ticks | 0}`);

      const wx = world.weather || {};
      let weather = 'clear';
      if (wx.thunder > 0.01 || wx.thundering) weather = `thunderstorm ${Math.round((wx.thunder || 1) * 100)}%`;
      else if (wx.rain > 0.01 || wx.raining) weather = `rain ${Math.round((wx.rain || 1) * 100)}%`;
      let precip = 'rain';
      try {
        const b = p ? world.biomeAt(Math.floor(p.x), Math.floor(p.z)) : null;
        if (b && b.precipitation) precip = b.precipitation;
      } catch { /* keep default */ }
      const wLine = `Weather: ${weather}  (precipitation: ${precip})`
        + (world.lightningTicks > 0 ? '  LIGHTNING' : '');
      col.push(wLine, weather === 'clear' ? '' : 'warn');
    } else {
      col.push('Time: no world loaded');
      col.push('Weather: --');
    }

    // --- session ----------------------------------------------------------
    col.push(`Dimension: ${Game.dimension}   Mode: ${Game.mode}   `
      + `Difficulty: ${DIFFICULTY_NAMES[clamp(Game.difficulty | 0, 0, 3)]}`);
    col.push(`World: ${Game.worldName}   Seed: ${Game.seed}`);

    // --- degraded subsystems ---------------------------------------------
    const broken = this._broken();
    if (broken.length) {
      col.gap();
      col.push(`DEGRADED SUBSYSTEMS (${broken.length})`, 'bad');
      for (let i = 0; i < broken.length && i < 12; i++) col.push('  ! ' + broken[i], 'bad');
      if (broken.length > 12) col.push(`  ... ${broken.length - 12} more`, 'bad');
    }
    const notes = this._bootNotes();
    if (notes.length) {
      col.push(`boot notes: ${notes.length} (see console)`, 'warn');
    }

    col.end();
  }

  // -------------------------------------------------------------------------
  // Right column: memory, GPU, registries and the crosshair target
  // -------------------------------------------------------------------------
  _buildRight() {
    const col = this.right;
    if (!col) return;
    col.begin();

    // --- JS heap ----------------------------------------------------------
    const mem = typeof performance !== 'undefined' ? performance.memory : null;
    if (mem && mem.jsHeapSizeLimit) {
      const used = mem.usedJSHeapSize || 0;
      const total = mem.totalJSHeapSize || 0;
      const limit = mem.jsHeapSizeLimit || 1;
      const pct = Math.round((used / limit) * 100);
      const allocPct = Math.round((total / limit) * 100);
      col.push(`Mem: ${pct}% ${mb(used)}/${mb(limit)} MB`, pct > 85 ? 'bad' : pct > 65 ? 'warn' : '');
      col.push(`Allocated: ${allocPct}% ${mb(total)} MB`);
    } else {
      col.push('Mem: performance.memory unavailable');
    }

    // --- display ----------------------------------------------------------
    const dw = window.innerWidth, dh = window.innerHeight;
    col.push(`Display: ${dw}x${dh}  dpr ${num(window.devicePixelRatio || 1, 2)}`);

    // --- three.js renderer info ------------------------------------------
    const r = Game.renderer;
    const info = r && r.info;
    if (info) {
      const rr = info.render || {};
      const mm = info.memory || {};
      col.push(`Renderer: calls ${int(rr.calls)}  tris ${big(rr.triangles)}  `
        + `lines ${int(rr.lines)}  pts ${int(rr.points)}`);
      col.push(`GPU objects: ${int(mm.geometries)} geometries, ${int(mm.textures)} textures, `
        + `${info.programs ? info.programs.length : 0} programs`);
      let px = 1;
      try { px = r.getPixelRatio ? r.getPixelRatio() : 1; } catch { px = 1; }
      col.push(`Framebuffer: ${Math.round(dw * px)}x${Math.round(dh * px)}  pixelRatio ${num(px, 2)}`);
    } else {
      col.push('Renderer: unavailable', 'bad');
    }

    // --- WebGL strings ----------------------------------------------------
    const gl = this._webglInfo();
    col.push(`GPU: ${shorten(gl.renderer)}`);
    col.push(`Vendor: ${shorten(gl.vendor)}`);
    col.push(`GL: ${gl.version ? shorten(gl.version) : 'unavailable'}`);
    if (gl.glsl) col.push(`GLSL: ${shorten(gl.glsl)}`);
    if (gl.maxTexture) col.push(`Max texture ${gl.maxTexture}px, ${gl.maxUnits} units`);

    // --- atlas ------------------------------------------------------------
    const atlas = Game.atlas;
    if (atlas) {
      const size = atlas.size || (atlas.canvas ? atlas.canvas.width : 0);
      const tile = atlas.tile || 16;
      const cols = atlas.cols || (size && tile ? size / tile : 0);
      let tiles = 0;
      try { tiles = atlas.count || 0; } catch { tiles = 0; }
      col.push(`Atlas: ${size}x${size}px, ${tile}px tiles, ${cols} cols, ${tiles} used`);
    } else {
      col.push('Atlas: not built', 'bad');
    }

    col.gap();

    // --- registry counts --------------------------------------------------
    col.push('Registries', 'header');
    for (const line of this._registryLines()) col.push(line);

    col.gap();
    col.push('Chunk map  grn meshed  blu lit  ylw lighting');
    col.push('org dirty  brn gen  pur queued');

    col.gap();

    // --- crosshair target -------------------------------------------------
    this._buildTarget(col);

    col.end();
  }

  /** Targeted block / entity block, appended to the right column. */
  _buildTarget(col) {
    const p = Game.player;
    const world = Game.world;
    if (!p || !world) { col.push('Targeted Block: (no player)'); return; }

    let hit = p.hitResult;
    if (!hit && typeof p.raycastTarget === 'function') {
      try { hit = p.raycastTarget(); } catch { hit = null; }
    }
    const entity = hit && hit.entity;
    const block = hit && hit.block;

    if (entity) {
      col.push('Targeted Entity', 'header');
      const name = entity.customName || entity.type || 'entity';
      col.push(`${name}  #${entity.id}`);
      col.push(`pos ${num(entity.x, 2)} / ${num(entity.y, 2)} / ${num(entity.z, 2)}`);
      col.push(`dist ${num(p.distanceTo ? p.distanceTo(entity) : NaN, 2)}m  `
        + `hp ${num(entity.health, 1)}/${num(entity.maxHealth, 1)}`);
      col.push(`model ${entity.modelName || '?'}  skin ${entity.skinName || '?'}  `
        + `cat ${entity.category || '?'}`);
      col.push(`size ${num(entity.width, 2)}x${num(entity.height, 2)}  age ${entity.age | 0}t  `
        + `ground ${entity.onGround ? 'y' : 'n'}`);
      col.push(`vel ${num(entity.vx, 2)} ${num(entity.vy, 2)} ${num(entity.vz, 2)}`);
      col.push(`effects: ${shorten(effectSummary(entity), 40)}`);
      if (entity.target) col.push(`target: #${entity.target.id} ${entity.target.type || ''}`);
      col.gap();
    }

    if (!block) {
      col.push('Targeted Block: (nothing in reach)');
      return;
    }

    const id = block.blockId | 0;
    const meta = block.meta | 0;
    let def = null;
    try { def = getBlock(id); } catch { def = null; }

    col.push('Targeted Block', 'header');
    col.push(`${block.x} ${block.y} ${block.z}  ${num(block.distance, 2)}m  `
      + `face ${block.faceName || FACE_NAMES[block.face] || '?'}`);
    col.push(`${def ? def.name : 'unknown'}  id ${id}  meta ${meta}  `
      + `raw 0x${(((meta & 15) << 12) | (id & 0xfff)).toString(16).padStart(4, '0')}`);

    if (!def) { col.push('(no block definition registered)', 'bad'); return; }

    col.push(`display "${def.display}"  group ${def.group}  model ${def.model}`);
    col.push(`pass ${def.renderPass}  tint ${def.tint == null ? 'none'
      : (typeof def.tint === 'number' ? '#' + def.tint.toString(16) : def.tint)}`);
    let texName = '';
    try { texName = getTexture(id, meta, block.face) || ''; } catch { texName = ''; }
    col.push(`texture ${shorten(texName || texSummary(def), 40)}`);
    col.push(`hardness ${num(def.hardness, 2)}  resistance ${num(def.resistance, 1)}  `
      + `tool ${def.tool || 'none'} t${def.tier}${def.requiresTool ? '!' : ''}`);
    col.push(`light ${def.light}  filter ${def.filter}  sound ${def.sound}  `
      + `slip ${num(def.slipperiness, 2)}`);
    col.push(`solid ${def.solid ? 'y' : 'n'}  opaque ${def.opaque ? 'y' : 'n'}  `
      + `liquid ${def.liquid || 'no'}  repl ${def.replaceable ? 'y' : 'n'}`);
    col.push(`gravity ${def.gravity ? 'y' : 'n'}  climb ${def.climbable ? 'y' : 'n'}  `
      + `randTick ${def.ticksRandomly ? 'y' : 'n'}  flam ${def.flammable}`);
    col.push(`collision ${def.collision}  boxes ${def.boxes ? def.boxes.length : 0}  `
      + `burn ${def.burnTime}t`);
    col.push(`drops: ${shorten(dropsSummary(def), 40)}`);
    if (def.entityType) {
      let be = null;
      try { be = world.getBlockEntity(block.x, block.y, block.z); } catch { be = null; }
      col.push(`block entity: ${def.entityType}${be ? ' (present)' : ' (missing)'}`,
        be ? '' : 'warn');
    }

    // Light state at the targeted block, handy when debugging propagation.
    try {
      const s = world.getSkyLight(block.x, block.y, block.z) | 0;
      const b = world.getBlockLight(block.x, block.y, block.z) | 0;
      col.push(`block light: ${s} sky / ${b} block`);
    } catch { /* optional */ }
  }

  // -------------------------------------------------------------------------
  // Cached lookups
  // -------------------------------------------------------------------------
  /** window.__mc.broken(), defensively. */
  _broken() {
    try {
      const mc = typeof window !== 'undefined' ? window.__mc : null;
      const b = mc && typeof mc.broken === 'function' ? mc.broken() : null;
      return Array.isArray(b) ? b : [];
    } catch { return []; }
  }

  /** window.__mc.bootNotes, defensively. */
  _bootNotes() {
    try {
      const mc = typeof window !== 'undefined' ? window.__mc : null;
      const n = mc && mc.bootNotes;
      return Array.isArray(n) ? n : [];
    } catch { return []; }
  }

  /** Registry counts from window.__mc.counts(), refreshed occasionally. */
  _registryLines() {
    if (this._counts && this._countTimer < COUNT_INTERVAL) return this._counts;
    this._countTimer = 0;
    let counts = null;
    try {
      const mc = typeof window !== 'undefined' ? window.__mc : null;
      if (mc && typeof mc.counts === 'function') counts = mc.counts();
    } catch { counts = null; }

    const lines = [];
    if (!counts) {
      lines.push('  window.__mc.counts() unavailable');
      this._counts = lines;
      return lines;
    }
    const entries = Object.keys(counts);
    for (let i = 0; i < entries.length; i += 2) {
      let s = '  ';
      for (let j = i; j < i + 2 && j < entries.length; j++) {
        const k = entries[j];
        s += pad(`${k} ${counts[k]}`, 20);
      }
      lines.push(s.replace(/\s+$/, ''));
    }
    this._counts = lines;
    return lines;
  }

  /** WebGL vendor/renderer strings; cached once a context exists. */
  _webglInfo() {
    if (this._glInfo) return this._glInfo;
    const out = {
      vendor: 'unavailable', renderer: 'unavailable', version: '',
      glsl: '', maxTexture: 0, maxUnits: 0,
    };
    let gl = null;
    try { gl = Game.renderer && Game.renderer.getContext ? Game.renderer.getContext() : null; } catch { gl = null; }
    if (!gl) return out;      // not cached: retry once the renderer exists
    try {
      out.vendor = gl.getParameter(gl.VENDOR) || out.vendor;
      out.renderer = gl.getParameter(gl.RENDERER) || out.renderer;
      out.version = gl.getParameter(gl.VERSION) || '';
      out.glsl = gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || '';
      out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
      out.maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) || 0;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        out.vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || out.vendor;
        out.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || out.renderer;
      }
    } catch { /* masked contexts throw; the defaults stand */ }
    this._glInfo = out;
    return out;
  }
}

export default DebugOverlay;
