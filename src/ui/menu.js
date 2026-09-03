// ============================================================================
// menu.js - Title, world select, world creation, pause, options, death and the
// end-credits screen. (CONTRACT.md section 28)
//
// Rules this file follows:
//
//  1. Exactly one screen is mounted in `#menu-layer` at a time. `_open()`
//     tears the previous one down (listeners, rAF loops, timers) before
//     building the next, so nothing leaks between screens.
//  2. Every reach into another subsystem (`Game.save`, `Game.audio`,
//     `Game.input`, `Game.player`, `window.__mc`) goes through a guard. A
//     half-finished neighbour must grey out one button, never blank the menu.
//  3. Every control is a real focusable element: `<button>`, `<input>`, or a
//     div carrying `tabindex` + an ARIA role and its own key handling. Arrow
//     keys walk the current screen's controls, Escape goes back.
//  4. The options screen is generated entirely from SETTINGS_SCHEMA. Nothing
//     here hard-codes a label, a range or a default.
//  5. No external assets: the logo is a bitmap font rendered as divs and the
//     panorama is painted into a canvas at runtime.
// ============================================================================
import { Game } from '../core/game.js';
import {
  GAMEMODE, DIFFICULTY, SEA_LEVEL, DIM_OVERWORLD, DIM_NETHER, DIM_END,
} from '../core/constants.js';
import { clamp, lerp, prettyName, formatTime } from '../core/util.js';
import { RNG, hashString, hashFloat } from '../core/rng.js';
import {
  SETTINGS_SCHEMA, SETTINGS_CATEGORIES, schemaByCategory, keyLabel,
  KEYBIND_LABELS, KEYBIND_ACTIONS, DEFAULT_KEYBINDS,
} from '../core/settings.js';

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** Yellow splash lines. One is picked at random every time the title mounts. */
export const SPLASHES = Object.freeze([
  'Also try inventing a build step!',
  '100% procedurally generated guilt!',
  'Now with 67% more sixty-seven!',
  'The creeper is a feature.',
  'No textures were harmed in the making of this game.',
  'It works on my machine!',
  'Made entirely out of <div>s and hope.',
  'Zero assets. Infinite regret.',
  'Voxels all the way down!',
  'Try not to fall out of the world.',
  'Diamonds are at y=12. Probably.',
  'Punch a tree. You know you want to.',
  'Sand does not respect gravity here. Except it does.',
  'The lava is just spicy water.',
  'Herobrine removed!',
  'Herobrine re-added!',
  'Ask your doctor if mining is right for you.',
  'Chunk borders are a state of mind.',
  'Powered by trigonometry and stubbornness.',
  'This splash text is load-bearing.',
  'Now rendering at up to several frames per second!',
  'Written by forty agents who never met.',
  'Do not eat the rotten flesh.',
  'The sheep are watching.',
  'Every block is a promise.',
  'Redstone: it is basically wizardry.',
  'Careful, the floor is procedurally generated.',
  'Silk touch this splash text!',
  'Enchanted with Unbreaking IV!',
  'A perfectly cromulent voxel engine.',
  'Bring a bucket.',
  'Do not dig straight down.',
  'Seriously, do not dig straight down.',
  'The end poem is original, we promise.',
  'Contains no actual minecarts. Wait, it does.',
  'Crafted from raw JavaScript ore.',
  'Baked at 20 ticks per second.',
  'That is not a bug, that is emergent gameplay.',
  'Villagers hmm at you judgmentally.',
  'Beware of the night.',
  'Torches are load-bearing here too.',
  'Sixty-seven is a perfectly good number.',
  'As seen in exactly one browser tab!',
  'Your world, your rules, your framerate.',
  'Featuring water that mostly behaves.',
  'Emeralds not included.',
  'The nether is warmer than it looks.',
  'Pet the wolf. Do it.',
  'Ninety percent of statistics are cobblestone.',
  'Now loading: everything, at once.',
  'It is dangerous to go alone. Take a pickaxe.',
  'Please do not name your world after your password.',
]);

/**
 * An original end-poem-style credits text in the shape of the game's own
 * ending: two quiet voices talking about the player. Not the vanilla poem.
 * `c` is one of the .mc-c-* colour classes from style.css.
 */
const END_POEM = Object.freeze([
  { t: '', c: '' },
  { t: 'I see the player you mean.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'PLAYERNAME?', c: 'aqua' },
  { t: '', c: '' },
  { t: 'Yes. Careful. It has reached the end of the world.', c: 'light_purple' },
  { t: 'It has walked a very long way to get here.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'It has been dreaming of this ending for a long time.', c: 'aqua' },
  { t: 'It dreamed of stone, and of light, and of the small warm', c: 'aqua' },
  { t: 'square of a torch held out against the dark.', c: 'aqua' },
  { t: '', c: '' },
  { t: 'It dug. That is the whole of it. It dug, and it built,', c: 'light_purple' },
  { t: 'and when the night came it built something to hide in,', c: 'light_purple' },
  { t: 'and in the morning it went out and dug again.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'Such a simple thing to do, over and over.', c: 'aqua' },
  { t: '', c: '' },
  { t: 'Simple things repeated become a life.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'Tell me about the dragon.', c: 'aqua' },
  { t: '', c: '' },
  { t: 'The dragon was the last thing that told the player no.', c: 'light_purple' },
  { t: 'And the player said no back, which is the oldest',  c: 'light_purple' },
  { t: 'conversation there is.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'Does it know the world was only ever numbers?', c: 'aqua' },
  { t: 'A seed. Some noise. A little arithmetic, repeated', c: 'aqua' },
  { t: 'until it looked like weather and mountains.', c: 'aqua' },
  { t: '', c: '' },
  { t: 'It knows. It does not mind.', c: 'light_purple' },
  { t: 'It knows the sunrise is a formula, and it watched', c: 'light_purple' },
  { t: 'the sunrise anyway, from the roof it built itself.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'That is the trick, then.', c: 'aqua' },
  { t: '', c: '' },
  { t: 'That is the whole trick. To be told the world is made', c: 'light_purple' },
  { t: 'of small dumb rules, and to answer: then I will make', c: 'light_purple' },
  { t: 'something out of the small dumb rules.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'It is time for the player to wake up.', c: 'aqua' },
  { t: '', c: '' },
  { t: 'Yes. Let it wake.', c: 'light_purple' },
  { t: 'Let it put down the controller and stand up and find', c: 'light_purple' },
  { t: 'that the other world, the loud slow heavy one, is also', c: 'light_purple' },
  { t: 'made of small rules it is allowed to build with.', c: 'light_purple' },
  { t: '', c: '' },
  { t: 'Wake up, PLAYERNAME.', c: 'aqua' },
  { t: '', c: '' },
  { t: 'Wake up.', c: 'light_purple' },
  { t: '', c: '' },
  { t: '', c: '' },
  { t: 'MINECRAFT67', c: 'yellow' },
  { t: '', c: '' },
  { t: 'A browser voxel game with no build step,', c: 'gray' },
  { t: 'no bundler and no external assets.', c: 'gray' },
  { t: '', c: '' },
  { t: 'Every texture is painted into a canvas at boot.', c: 'gray' },
  { t: 'Every sound is an oscillator and a filter.', c: 'gray' },
  { t: 'Every mountain is a number you chose yourself.', c: 'gray' },
  { t: '', c: '' },
  { t: 'Thank you for playing.', c: 'yellow' },
  { t: '', c: '' },
  { t: '', c: '' },
]);

/**
 * A 5x7 bitmap font, just wide enough for the title logo. '#' is a lit pixel.
 */
const LOGO_FONT = Object.freeze({
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
});

const LOGO_TEXT = 'MINECRAFT67';
/** Index in LOGO_TEXT where the green "67" accent starts. */
const LOGO_ACCENT_AT = 9;

const GAMEMODE_OPTIONS = Object.freeze([
  { value: GAMEMODE.SURVIVAL, label: 'Survival', hint: 'Search for resources, craft, gain levels, health and hunger.' },
  { value: GAMEMODE.CREATIVE, label: 'Creative', hint: 'Unlimited resources, free flying and instant block breaking.' },
  { value: GAMEMODE.ADVENTURE, label: 'Adventure', hint: 'Explore, but blocks cannot be freely broken or placed.' },
  { value: GAMEMODE.SPECTATOR, label: 'Spectator', hint: 'Fly through the world without touching anything.' },
]);

const DIFFICULTY_OPTIONS = Object.freeze([
  { value: DIFFICULTY.PEACEFUL, label: 'Peaceful', hint: 'No hostile mobs. Health regenerates on its own.' },
  { value: DIFFICULTY.EASY, label: 'Easy', hint: 'Hostile mobs spawn but hit softly. Hunger stops at half a heart.' },
  { value: DIFFICULTY.NORMAL, label: 'Normal', hint: 'The intended experience.' },
  { value: DIFFICULTY.HARD, label: 'Hard', hint: 'Mobs hit hard, hunger can kill and zombies break doors.' },
]);

const DIMENSION_LABELS = Object.freeze({
  [DIM_OVERWORLD]: 'Overworld',
  [DIM_NETHER]: 'Nether',
  [DIM_END]: 'The End',
});

/** Every category the options screen shows as a tab, plus the keybind page. */
const KEYBIND_TAB = Object.freeze({ id: '__keys', label: 'Key Binds' });

/** Sub-headings inside the keybind page, in display order. */
const KEYBIND_GROUP_LABELS = Object.freeze([
  ['movement', 'Movement'],
  ['gameplay', 'Gameplay'],
  ['interface', 'Interface'],
  ['hotbar', 'Hotbar'],
]);

/** Version string in the title footer. */
const VERSION_LINE = 'minecraft67 1.20 (browser edition)';
const COPYRIGHT_LINE = 'Not affiliated with Mojang. Everything here is drawn at runtime.';

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

/** Creates an element with a class, optional text, appended to `parent`. */
function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (parent) parent.appendChild(e);
  return e;
}

/** Removes every child of a node without touching the node itself. */
function empty(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Runs `fn`, swallowing anything a half-written neighbour throws. */
function tryCall(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

/** The public surface main.js publishes on `window.__mc`, or null. */
function api() {
  return (typeof window !== 'undefined' && window.__mc) ? window.__mc : null;
}

/** Short UI click. Also nudges the audio engine awake on the first gesture. */
let audioWoken = false;
function click() {
  const a = Game.audio;
  if (!a) return;
  try {
    if (!audioWoken && typeof a.init === 'function') { a.init(); audioWoken = true; }
    if (typeof a.play === 'function') a.play('click', { volume: 0.55, pitch: 1 });
  } catch (e) { /* audio is optional */ }
}

/** True when the player asked for less animation. */
function reducedMotion() {
  const s = tryCall(() => Game.settings && Game.settings.get('reducedMotion'), false);
  if (s) return true;
  return tryCall(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, false);
}

/** '3 minutes ago', 'yesterday', '12 Mar 2026'. */
function relativeTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  const d = Date.now() - ms;
  if (d < 0) return 'just now';
  const min = d / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)} min ago`;
  const hours = min / 60;
  if (hours < 24) return `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'} ago`;
  const days = hours / 24;
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.floor(days)} days ago`;
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return new Date(ms).toDateString();
  }
}

/** Turns whatever the seed box holds into the unsigned int worldgen wants. */
function parseSeed(text) {
  const s = String(text == null ? '' : text).trim();
  if (s === '') return (Math.random() * 0x7fffffff) >>> 0;
  if (/^-?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n >>> 0;
  }
  return hashString(s) >>> 0;
}

/** Human label for a game mode value. */
function modeLabel(mode) {
  const o = GAMEMODE_OPTIONS.find((m) => m.value === mode);
  return o ? o.label : prettyName(String(mode || 'survival'));
}

/** Human label for a difficulty value. */
function difficultyLabel(v) {
  const o = DIFFICULTY_OPTIONS.find((d) => d.value === v);
  return o ? o.label : 'Normal';
}

// ---------------------------------------------------------------------------
// The title-screen panorama
//
// Four parallax layers painted once into offscreen canvases, then blitted with
// different scroll speeds. The silhouettes are built from a sum of sines with
// integer frequencies, which makes them exactly seamless when they wrap. The
// whole thing runs at half resolution behind a CSS blur, so a frame costs a
// handful of drawImage calls.
// ---------------------------------------------------------------------------

const PANO_W = 1024;
const PANO_H = 256;

/** Draws one blocky, horizontally seamless terrain silhouette. */
function paintLayer(seed, opts) {
  const c = document.createElement('canvas');
  c.width = PANO_W;
  c.height = PANO_H;
  const g = c.getContext('2d');
  if (!g) return c;
  const rng = new RNG(seed);
  const block = opts.block || 8;
  const cols = Math.ceil(PANO_W / block);

  // Sum-of-sines profile. Integer frequencies => period exactly PANO_W.
  const waves = [];
  for (let i = 0; i < 4; i++) {
    waves.push({
      f: opts.freq[i] || (i + 1),
      a: opts.amp[i] || 8,
      p: rng.next() * Math.PI * 2,
    });
  }
  const heights = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const u = (i * block) / PANO_W;
    let h = opts.base;
    for (const w of waves) h += Math.sin(u * Math.PI * 2 * w.f + w.p) * w.a;
    heights[i] = Math.round(h / block) * block;
  }

  g.fillStyle = opts.body;
  for (let i = 0; i < cols; i++) {
    const x = i * block;
    const top = PANO_H - heights[i];
    g.fillRect(x, top, block, PANO_H - top);
  }
  // Grass/snow cap on top of each column.
  g.fillStyle = opts.cap;
  for (let i = 0; i < cols; i++) {
    g.fillRect(i * block, PANO_H - heights[i], block, block);
  }
  // A faint block grid so it reads as voxels rather than a smooth hill.
  g.strokeStyle = opts.grid;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i <= cols; i++) {
    const x = i * block + 0.5;
    const top = PANO_H - Math.max(heights[Math.min(i, cols - 1)], heights[Math.max(i - 1, 0)]);
    g.moveTo(x, top);
    g.lineTo(x, PANO_H);
  }
  for (let y = 0; y < PANO_H; y += block) { g.moveTo(0, y + 0.5); g.lineTo(PANO_W, y + 0.5); }
  g.stroke();

  // Trees, kept clear of the seam so the wrap stays invisible.
  if (opts.trees) {
    for (let n = 0; n < opts.trees; n++) {
      const i = 2 + Math.floor(rng.next() * (cols - 5));
      const x = i * block;
      if (x < block * 2 || x > PANO_W - block * 4) continue;
      const groundY = PANO_H - heights[i];
      const trunk = block * (2 + Math.floor(rng.next() * 2));
      g.fillStyle = opts.trunk;
      g.fillRect(x, groundY - trunk, block, trunk);
      g.fillStyle = opts.leaves;
      g.fillRect(x - block, groundY - trunk - block * 2, block * 3, block * 2);
      g.fillRect(x - block * 0.5, groundY - trunk - block * 3, block * 2, block);
    }
  }
  return c;
}

/** Blocky drifting clouds on their own transparent layer. */
function paintClouds(seed) {
  const c = document.createElement('canvas');
  c.width = PANO_W;
  c.height = PANO_H;
  const g = c.getContext('2d');
  if (!g) return c;
  const rng = new RNG(seed);
  g.fillStyle = 'rgba(255,255,255,0.82)';
  for (let n = 0; n < 14; n++) {
    const x = rng.next() * (PANO_W - 140);
    const y = 14 + rng.next() * 70;
    const w = 40 + rng.next() * 90;
    const h = 8 + rng.next() * 10;
    g.fillRect(x, y, w, h);
    g.fillRect(x + w * 0.2, y - h * 0.7, w * 0.55, h * 0.8);
    g.fillRect(x + w * 0.55, y + h * 0.6, w * 0.4, h * 0.6);
  }
  return c;
}

/**
 * Scrolling parallax backdrop for the title screen. Cheap enough to leave
 * running; stops itself when hidden, when the tab is in the background and
 * when the player asked for reduced motion.
 */
class Panorama {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.layers = null;
    this.raf = 0;
    this.t0 = 0;
    this._onResize = null;
  }

  /** Builds the layer canvases once and caches them on the instance. */
  _build() {
    if (this.layers) return this.layers;
    const seed = 67;
    this.layers = [
      {
        canvas: paintLayer(seed + 1, {
          base: 96, block: 8, freq: [1, 2, 3, 5], amp: [26, 14, 7, 4],
          body: '#6d84a8', cap: '#8fa4c4', grid: 'rgba(20,30,50,0.16)',
          trunk: '#4d5c74', leaves: '#5d7794', trees: 0,
        }),
        speed: 5, hFrac: 0.52, yOff: 0.06,
      },
      {
        canvas: paintLayer(seed + 2, {
          base: 74, block: 8, freq: [1, 3, 4, 7], amp: [20, 12, 6, 3],
          body: '#4a6b3c', cap: '#6fa04b', grid: 'rgba(10,25,10,0.2)',
          trunk: '#4a3524', leaves: '#3f6b32', trees: 10,
        }),
        speed: 11, hFrac: 0.42, yOff: 0.02,
      },
      {
        canvas: paintLayer(seed + 3, {
          base: 58, block: 10, freq: [2, 3, 5, 8], amp: [16, 9, 5, 3],
          body: '#6b5136', cap: '#77b048', grid: 'rgba(0,0,0,0.24)',
          trunk: '#5a3f28', leaves: '#4e8a35', trees: 14,
        }),
        speed: 22, hFrac: 0.34, yOff: 0,
      },
    ];
    this.clouds = { canvas: paintClouds(seed + 9), speed: 7, hFrac: 0.55, yOff: -0.28 };
    return this.layers;
  }

  /** Attaches the canvas to a parent and starts the loop. */
  mount(parent) {
    if (!parent || typeof document === 'undefined') return;
    let canvas;
    try {
      canvas = document.createElement('canvas');
      this.ctx = canvas.getContext('2d');
    } catch (e) { this.ctx = null; }
    if (!this.ctx) return;            // the CSS gradient behind us is the fallback
    this.canvas = canvas;
    canvas.className = 'pixel';
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;display:block;' +
      'filter:blur(1.5px) saturate(1.05);transform:scale(1.08);z-index:0;pointer-events:none;';
    parent.insertBefore(canvas, parent.firstChild);
    tryCall(() => this._build(), null);
    this.t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
    const still = reducedMotion();
    this._draw(0);
    if (!still) this._loop();
  }

  _resize() {
    const c = this.canvas;
    if (!c) return;
    const w = Math.max(2, Math.ceil((c.clientWidth || window.innerWidth) / 2));
    const h = Math.max(2, Math.ceil((c.clientHeight || window.innerHeight) / 2));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  _loop() {
    if (!this.canvas) return;
    this.raf = requestAnimationFrame(() => {
      if (!this.canvas) return;
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (!(typeof document !== 'undefined' && document.hidden)) {
        this._draw((now - this.t0) / 1000);
      }
      this._loop();
    });
  }

  /** One frame: sky, sun, clouds, three terrain layers, ground haze. */
  _draw(t) {
    const g = this.ctx, c = this.canvas;
    if (!g || !c) return;
    const W = c.width, H = c.height;

    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#3f6fd8');
    sky.addColorStop(0.42, '#79a8ff');
    sky.addColorStop(0.78, '#bcd7ff');
    sky.addColorStop(1, '#e6d6b4');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);

    // Minecraft's sun is a square, and so is ours.
    const sunX = W * 0.74 + Math.sin(t * 0.05) * W * 0.02;
    const sunY = H * 0.17;
    const sunS = Math.max(10, H * 0.11);
    g.fillStyle = 'rgba(255,246,196,0.28)';
    g.fillRect(sunX - sunS, sunY - sunS, sunS * 3, sunS * 3);
    g.fillStyle = '#fff6c4';
    g.fillRect(sunX, sunY, sunS, sunS);

    const layers = this.layers;
    if (!layers) return;

    const blit = (layer, speed, hFrac, yOff) => {
      const src = layer;
      if (!src || !src.width) return;
      const dh = H * hFrac;
      const dw = dh * (src.width / src.height);
      if (!(dw > 1)) return;
      let x = -(((t * speed) % dw) + dw) % dw;
      const dy = H - dh + yOff * H;
      while (x < W) { g.drawImage(src, x, dy, dw, dh); x += dw; }
    };

    if (this.clouds) blit(this.clouds.canvas, this.clouds.speed, this.clouds.hFrac, this.clouds.yOff);
    for (const L of layers) blit(L.canvas, L.speed, L.hFrac, L.yOff);

    // A touch of distance haze so the far layer sits back.
    const haze = g.createLinearGradient(0, H * 0.45, 0, H);
    haze.addColorStop(0, 'rgba(150,190,255,0.22)');
    haze.addColorStop(1, 'rgba(60,80,50,0)');
    g.fillStyle = haze;
    g.fillRect(0, H * 0.45, W, H * 0.55);
  }

  /** Stops the loop and detaches the canvas. Safe to call twice. */
  destroy() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this._onResize) { window.removeEventListener('resize', this._onResize); this._onResize = null; }
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    this.ctx = null;
    // Keep `layers` cached: repainting them is the only expensive part.
  }
}

// ---------------------------------------------------------------------------
// The blocky logo
// ---------------------------------------------------------------------------

/**
 * Builds MINECRAFT67 out of one div per lit pixel, wrapped in `.menu-title`
 * so it inherits the CSS sway. Letters get a tiny staggered bob through the
 * Web Animations API, which needs no stylesheet of its own.
 */
function buildLogo(text = LOGO_TEXT) {
  const wrap = el('h1', 'menu-title mc-logo');
  wrap.setAttribute('aria-label', text);
  wrap.style.cssText =
    '--lpx:min(calc(var(--gs) * 3px), 1.25vw);' +
    'display:flex;align-items:flex-end;justify-content:center;' +
    'gap:var(--lpx);padding:0 var(--u8);' +
    'filter:drop-shadow(calc(var(--lpx) * 1.5) calc(var(--lpx) * 1.5) 0 rgba(0,0,0,0.55));';

  const still = reducedMotion();
  // The in-game "Reduced Motion" option is ours to honour; the OS preference
  // is already handled by the media query in style.css.
  if (still) wrap.style.animation = 'none';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const glyph = LOGO_FONT[ch];
    if (!glyph) continue;
    const accent = i >= LOGO_ACCENT_AT;
    const face = accent ? '#7cbd54' : '#d0d0d0';
    const hi = accent ? 'rgba(206,255,168,0.75)' : 'rgba(255,255,255,0.7)';
    const lo = accent ? 'rgba(16,44,10,0.55)' : 'rgba(0,0,0,0.42)';

    const letter = el('div', 'mc-logo-letter', wrap);
    letter.style.cssText =
      'position:relative;flex:0 0 auto;' +
      'width:calc(var(--lpx) * 5);height:calc(var(--lpx) * 7);';
    for (let r = 0; r < glyph.length; r++) {
      const row = glyph[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '#') continue;
        const p = el('div', null, letter);
        p.style.cssText =
          'position:absolute;width:var(--lpx);height:var(--lpx);' +
          `left:calc(var(--lpx) * ${c});top:calc(var(--lpx) * ${r});` +
          `background:${face};` +
          `box-shadow:inset 0 calc(var(--lpx) * 0.22) 0 ${hi},` +
          `inset 0 calc(var(--lpx) * -0.28) 0 ${lo};`;
      }
    }
    if (!still && typeof letter.animate === 'function') {
      tryCall(() => letter.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(-9%)' }, { transform: 'translateY(0)' }],
        { duration: 3400, iterations: Infinity, delay: i * 110, easing: 'ease-in-out' },
      ), null);
    }
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * Every full-screen menu the game has. One instance lives for the whole
 * session and owns `#menu-layer`; exactly one screen is mounted at a time.
 */
export class Menu {
  /** @param {HTMLElement} root the `#menu-layer` element */
  constructor(root) {
    this.root = root
      || (typeof document !== 'undefined' && document.getElementById('menu-layer'))
      || (typeof document !== 'undefined' ? document.createElement('div') : null);

    /** Name of the mounted screen, or null when nothing is showing. */
    this.screen = null;
    /** Where "Done"/Escape returns from the options screen. */
    this.optionsReturn = 'title';
    /** Currently selected options tab id. */
    this.optionsTab = SETTINGS_CATEGORIES[0] ? SETTINGS_CATEGORIES[0].id : 'video';
    /** Cached world list so re-entering the select screen is instant. */
    this.worlds = [];
    this.selectedWorld = null;
    /** Live snapshot of the player's lifetime XP, for the death score. */
    this.lastScore = 0;

    this.panorama = new Panorama();
    this.splash = SPLASHES[0];

    // Per-screen teardown handles.
    this._cleanups = [];
    this._raf = 0;
    this._listening = null;      // { action, btn, row } while rebinding a key
    this._listenCleanup = null;
    this._inputDisabled = false;
    this._modal = null;
    this.host = null;
    this._worldListEl = null;
    this._worldButtons = null;
    this._conflictLine = null;
    this._keyRows = null;

    this._onKeyDown = (e) => this._handleKey(e);
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this._onKeyDown, true);
    }

    // The saved GUI scale has to be pushed to CSS at least once per session.
    tryCall(() => {
      const gs = Game.settings && Game.settings.get('guiScale');
      if (gs !== undefined && gs !== null) {
        document.documentElement.style.setProperty('--gui-scale', String(gs));
      }
    }, null);

    // Death score: `player.xp` is zeroed inside kill(), so sample it while the
    // player is still alive. Both hooks together are cheap and accurate.
    const sample = () => {
      const p = Game.player;
      if (p && Number.isFinite(p.xp) && p.xp > 0) this.lastScore = p.xp | 0;
    };
    Game.on('playerhurt', sample);
    Game.on('tick', (n) => { if ((n & 15) === 0) sample(); });
    Game.on('playerrespawn', () => { this.lastScore = 0; });

    // The credits roll when the dragon dies, exactly once per world.
    this._creditsShown = false;
    Game.on('worldloaded', () => { this._creditsShown = false; });
    Game.on('entitydeath', (e) => {
      if (this._creditsShown) return;
      const type = e && (e.type || e.mobName);
      if (type !== 'ender_dragon') return;
      this._creditsShown = true;
      setTimeout(() => { tryCall(() => this.showWin(), null); }, 2500);
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** True while any screen is mounted. */
  get visible() { return this.screen !== null; }

  /** Alias some callers prefer. */
  isOpen() { return this.screen !== null; }

  /**
   * Tears the current screen down and mounts a new one.
   * @param {string} name screen id, used by `visible` and the Escape handler
   * @param {(host: HTMLElement) => void} build fills the container
   */
  _open(name, build) {
    if (!this.root) return null;
    this._teardown();
    this.screen = name;
    const host = document.createElement('div');
    host.className = 'menu-screen';
    host.style.cssText = 'position:absolute;inset:0;';
    host.dataset.screen = name;
    this.root.appendChild(host);
    this.host = host;
    try {
      build.call(this, host);
    } catch (err) {
      console.error('[menu] failed to build screen "' + name + '"', err);
      empty(host);
      const bg = el('div', 'menu-bg', host);
      el('h2', 'mc-title', bg, 'Menu unavailable');
      el('div', 'mc-hint', bg, String((err && err.message) || err));
      const row = el('div', 'menu-buttons', bg);
      row.appendChild(this._button('Back to Title', () => this.showTitle()));
    }
    // Give the first control focus so the keyboard works immediately.
    const first = host.querySelector('.mc-button:not([disabled]), [tabindex]');
    if (first && typeof first.focus === 'function') {
      tryCall(() => first.focus({ preventScroll: true }), null);
    }
    return host;
  }

  /** Removes the mounted screen and everything it registered. */
  _teardown() {
    this._closeModal();
    this._stopListening();
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    for (const fn of this._cleanups) tryCall(fn, null);
    this._cleanups.length = 0;
    tryCall(() => this.panorama.destroy(), null);
    this._enableGameInput();
    if (this.root) empty(this.root);
    this.host = null;
    this._worldListEl = null;
    this._worldButtons = null;
    this._conflictLine = null;
    this._keyRows = null;
  }

  /** Registers a teardown callback for the current screen. */
  _onCleanup(fn) { this._cleanups.push(fn); }

  /**
   * Clears the layer and hands the pointer back to the game.
   * Safe to call when nothing is showing.
   */
  hide() {
    if (!this.screen) return;
    this._teardown();
    this.screen = null;
    if (Game.started) {
      tryCall(() => Game.emit('resume'), null);
      tryCall(() => Game.input && Game.input.requestPointerLock(), null);
    }
  }

  /** Pauses the simulation and releases the pointer, for menus over a world. */
  _pauseGame() {
    if (!Game.started) return;
    tryCall(() => Game.emit('pause'), null);
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  /** A `.mc-button` that is focusable, clickable and Enter/Space activated. */
  _button(label, onClick, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mc-button' + (opts.cls ? ' ' + opts.cls : '');
    b.textContent = label;
    if (opts.title) b.title = opts.title;
    if (opts.disabled) { b.disabled = true; b.classList.add('disabled'); }
    b.addEventListener('click', (e) => {
      if (b.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      click();
      tryCall(() => onClick(e), null);
    });
    if (opts.onAlt) {
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (b.disabled) return;
        click();
        tryCall(() => opts.onAlt(e), null);
      });
    }
    return b;
  }

  /** A labelled text field wired so typing never reaches the game input. */
  _input(value, opts = {}) {
    const i = document.createElement('input');
    i.type = 'text';
    i.className = 'mc-input';
    i.value = value == null ? '' : String(value);
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.maxLength) i.maxLength = opts.maxLength;
    if (opts.label) i.setAttribute('aria-label', opts.label);
    i.spellcheck = false;
    i.autocomplete = 'off';
    i.addEventListener('focus', () => this._disableGameInput());
    i.addEventListener('blur', () => this._enableGameInput());
    // Keys typed into a field are the field's business, not the game's.
    i.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && opts.onEnter) { e.preventDefault(); tryCall(() => opts.onEnter(i.value), null); }
      if (e.key === 'Escape') { i.blur(); }
    });
    if (opts.onInput) i.addEventListener('input', () => tryCall(() => opts.onInput(i.value), null));
    return i;
  }

  /**
   * A draggable, keyboard-operable slider. `entry` is a SETTINGS_SCHEMA row;
   * `read`/`write` move the underlying value.
   */
  _slider(entry, read, write) {
    const min = entry.min === null || entry.min === undefined ? 0 : entry.min;
    const max = entry.max === null || entry.max === undefined ? 1 : entry.max;
    const step = entry.step || (max - min) / 100 || 0.01;

    const s = el('div', 'mc-slider');
    s.tabIndex = 0;
    s.setAttribute('role', 'slider');
    s.setAttribute('aria-label', entry.label);
    el('div', 'mc-slider-fill', s);
    el('div', 'mc-slider-knob', s);
    const label = el('div', 'mc-slider-label', s);

    const refresh = () => {
      const v = read();
      const f = max === min ? 0 : clamp((v - min) / (max - min), 0, 1);
      s.style.setProperty('--fill', String(f));
      label.textContent = entry.format ? entry.format(v) : String(v);
      s.setAttribute('aria-valuemin', String(min));
      s.setAttribute('aria-valuemax', String(max));
      s.setAttribute('aria-valuenow', String(v));
      s.setAttribute('aria-valuetext', label.textContent);
    };

    const setFromX = (clientX) => {
      const r = s.getBoundingClientRect();
      if (!r.width) return;
      const f = clamp((clientX - r.left) / r.width, 0, 1);
      const raw = min + f * (max - min);
      write(Math.round((raw - min) / step) * step + min);
      refresh();
    };

    let dragging = false;
    s.addEventListener('pointerdown', (e) => {
      dragging = true;
      tryCall(() => s.setPointerCapture(e.pointerId), null);
      s.focus({ preventScroll: true });
      setFromX(e.clientX);
      e.preventDefault();
    });
    s.addEventListener('pointermove', (e) => { if (dragging) setFromX(e.clientX); });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      tryCall(() => s.releasePointerCapture(e.pointerId), null);
      click();
    };
    s.addEventListener('pointerup', stop);
    s.addEventListener('pointercancel', stop);
    s.addEventListener('keydown', (e) => {
      // Up/Down belong to the screen-level row navigation, so the slider only
      // claims Left/Right (plus Page/Home/End).
      let d = 0;
      if (e.key === 'ArrowLeft') d = -1;
      else if (e.key === 'ArrowRight') d = 1;
      else if (e.key === 'PageDown') d = -10;
      else if (e.key === 'PageUp') d = 10;
      else if (e.key === 'Home') { write(min); refresh(); e.preventDefault(); e.stopPropagation(); return; }
      else if (e.key === 'End') { write(max); refresh(); e.preventDefault(); e.stopPropagation(); return; }
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      write(read() + step * d);
      refresh();
    });

    refresh();
    s.__refresh = refresh;
    return s;
  }

  /** A button that cycles a toggle/select option and shows its current value. */
  _cycler(entry, read, write) {
    const values = entry.type === 'toggle'
      ? [false, true]
      : (entry.options || []).map((o) => o.value);
    const b = this._button(entry.format ? entry.format(read()) : String(read()), () => step(1), {
      cls: 'small',
      title: entry.hint || '',
      onAlt: () => step(-1),
    });
    b.style.minWidth = 'calc(var(--gs) * 76px)';

    function step(dir) {
      const cur = read();
      let i = values.findIndex((v) => v === cur);
      if (i < 0) i = 0;
      i = ((i + dir) % values.length + values.length) % values.length;
      write(values[i]);
      b.textContent = entry.format ? entry.format(read()) : String(read());
    }
    b.__refresh = () => { b.textContent = entry.format ? entry.format(read()) : String(read()); };
    return b;
  }

  // -------------------------------------------------------------------------
  // Game input gating
  // -------------------------------------------------------------------------

  /** Silences core/input.js while a text field has focus. */
  _disableGameInput() {
    if (this._inputDisabled) return;
    const inp = Game.input;
    if (!inp || typeof inp.setEnabled !== 'function') return;
    this._inputDisabled = true;
    tryCall(() => inp.setEnabled(false), null);
  }

  /** Restores core/input.js. Always called from `_teardown`. */
  _enableGameInput() {
    if (!this._inputDisabled) return;
    this._inputDisabled = false;
    tryCall(() => Game.input && Game.input.setEnabled(true), null);
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  /** Escape / arrow navigation for whatever screen is mounted. */
  _handleKey(e) {
    if (this._listening) { this._captureBinding(e); return; }
    if (!this.screen) return;
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    if (e.key === 'Escape') {
      if (this._modal) { e.preventDefault(); e.stopPropagation(); this._closeModal(); return; }
      if (typing) return;
      e.preventDefault();
      e.stopPropagation();
      this._escape();
      return;
    }
    if (typing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = this._focusables();
      if (items.length < 2) return;
      e.preventDefault();
      e.stopPropagation();
      const down = e.key === 'ArrowDown';
      const i = items.indexOf(document.activeElement);
      const next = i < 0
        ? (down ? items[0] : items[items.length - 1])
        : items[(i + (down ? 1 : -1) + items.length) % items.length];
      if (next) tryCall(() => next.focus({ preventScroll: false }), null);
    }
  }

  /** Every focusable control on the mounted screen, in DOM order. */
  _focusables() {
    const host = this._modal || this.host;
    if (!host) return [];
    const nodes = host.querySelectorAll(
      'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
    );
    return Array.prototype.slice.call(nodes).filter((n) => n.offsetParent !== null);
  }

  /** What the Escape key means on each screen. */
  _escape() {
    switch (this.screen) {
      case 'title': break;
      case 'worlds': this.showTitle(); break;
      case 'create': this.showWorldSelect(); break;
      case 'options': this._leaveOptions(); break;
      case 'pause': this.hide(); break;
      case 'death': break;
      case 'win': this._endCredits(); break;
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // Confirmation dialog
  // -------------------------------------------------------------------------

  /** A modal yes/no panel over the current screen. */
  _confirm(title, lines, confirmLabel, onConfirm, opts = {}) {
    this._closeModal();
    const back = el('div', 'pause-screen');
    back.style.zIndex = '5';
    this.root.appendChild(back);
    this._modal = back;

    const panel = el('div', 'mc-panel dark', back);
    panel.style.cssText = 'display:flex;flex-direction:column;gap:var(--u4);' +
      'align-items:center;padding:var(--u8) var(--u10);max-width:calc(var(--gs) * 240px);';
    el('div', 'mc-title small', panel, title);
    for (const line of [].concat(lines || [])) {
      const p = el('div', 'mc-label', panel, line);
      p.style.textAlign = 'center';
    }
    const row = el('div', 'mc-row', panel);
    row.style.marginTop = 'var(--u4)';
    const yes = this._button(confirmLabel, () => {
      this._closeModal();
      tryCall(() => onConfirm(), null);
    }, { cls: opts.danger ? 'danger' : 'primary' });
    const no = this._button(opts.cancelLabel || 'Cancel', () => this._closeModal());
    row.appendChild(yes);
    if (!opts.single) row.appendChild(no);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) this._closeModal(); });
    tryCall(() => (opts.focusCancel ? no : yes).focus({ preventScroll: true }), null);
    return back;
  }

  /** Dismisses the modal, if any. */
  _closeModal() {
    if (!this._modal) return;
    if (this._modal.parentNode) this._modal.parentNode.removeChild(this._modal);
    this._modal = null;
    const first = this._focusables()[0];
    if (first) tryCall(() => first.focus({ preventScroll: true }), null);
  }

  /** Shared footer for the dirt-background screens. */
  _footer(host) {
    const f = el('div', 'menu-footer', host);
    el('span', 'menu-version', f, VERSION_LINE);
    el('span', 'menu-copyright', f, COPYRIGHT_LINE);
    return f;
  }

  // =========================================================================
  // Title screen
  // =========================================================================

  /** The main menu: panorama, logo, splash and the three big buttons. */
  showTitle() {
    this._pauseGame();
    Game.started = false;         // reaching the title always means we left the world
    this.splash = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];

    this._open('title', (host) => {
      const bg = el('div', 'menu-bg panorama', host);
      tryCall(() => this.panorama.mount(bg), null);
      el('div', 'menu-vignette', bg);

      const stack = el('div', 'mc-col', bg);
      stack.style.cssText = 'position:relative;z-index:1;align-items:center;gap:var(--u10);';

      const logo = buildLogo();
      const splash = el('span', 'menu-splash', logo, this.splash);
      splash.setAttribute('aria-hidden', 'true');
      if (reducedMotion()) splash.style.animation = 'none';
      stack.appendChild(logo);

      const buttons = el('div', 'menu-buttons', stack);
      buttons.appendChild(this._button('Singleplayer', () => this.showWorldSelect()));
      buttons.appendChild(this._button('Options...', () => this.showSettings('title')));

      const row = el('div', 'mc-row', buttons);
      row.appendChild(this._button('Credits', () => this.showWin(true)));
      row.appendChild(this._button('Quit', () => this._quit(), { cls: 'danger' }));

      const hint = el('div', 'mc-hint', stack);
      hint.textContent = 'Arrow keys move between buttons • Enter selects';

      this._footer(host);
    });
  }

  /** "Quit" in a browser: close if we own the tab, otherwise say so. */
  _quit() {
    this._confirm('Quit the game?', [
      'Browsers only let a page close itself if a script opened it.',
      'If nothing happens, just close the tab.',
    ], 'Quit', () => {
      tryCall(() => window.close(), null);
      setTimeout(() => {
        if (!this.screen) return;
        tryCall(() => Game.toast('Close the tab to quit.'), null);
      }, 300);
    }, { danger: true });
  }

  // =========================================================================
  // World select
  // =========================================================================

  /** Lists saved worlds with play / create / delete / re-create actions. */
  showWorldSelect() {
    this._pauseGame();
    this._open('worlds', (host) => {
      const bg = el('div', 'menu-bg', host);
      el('h2', 'mc-title', bg, 'Select World');

      const list = el('div', 'world-list mc-scroll', bg);
      list.setAttribute('role', 'listbox');
      el('div', 'mc-hint', list, 'Reading saved worlds…');

      const buttons = el('div', 'menu-buttons', bg);
      const rowA = el('div', 'mc-row', buttons);
      const playBtn = this._button('Play Selected World', () => this._playSelected(), { cls: 'primary', disabled: true });
      const createBtn = this._button('Create New World', () => this.showCreateWorld());
      rowA.appendChild(playBtn);
      rowA.appendChild(createBtn);

      const rowB = el('div', 'mc-row', buttons);
      const recreateBtn = this._button('Re-Create', () => this._recreateSelected(), { disabled: true,
        title: 'Start a fresh world using the same seed and settings.' });
      const deleteBtn = this._button('Delete', () => this._deleteSelected(), { cls: 'danger', disabled: true });
      rowB.appendChild(recreateBtn);
      rowB.appendChild(deleteBtn);

      buttons.appendChild(this._button('Back', () => this.showTitle()));

      this._worldButtons = { playBtn, recreateBtn, deleteBtn };
      this._worldListEl = list;
      Promise.resolve(this._loadWorlds()).catch((e) => console.error('[menu] world list', e));
      this._footer(host);
    });
  }

  /** Pulls the world list from the SaveManager and repaints the list box. */
  async _loadWorlds() {
    const list = this._worldListEl;
    if (!list) return;
    let worlds = [];
    const save = Game.save;
    if (!save || typeof save.listWorlds !== 'function') {
      empty(list);
      el('div', 'mc-hint', list, 'Saved worlds are unavailable in this browser.');
      return;
    }
    try {
      worlds = (await save.listWorlds()) || [];
    } catch (e) {
      worlds = [];
    }
    if (this.screen !== 'worlds' || list !== this._worldListEl) return;   // navigated away
    this.worlds = worlds;
    if (this.selectedWorld && !worlds.some((w) => w.name === this.selectedWorld)) {
      this.selectedWorld = null;
    }
    this._renderWorlds();
  }

  /** Rebuilds the `.world-item` rows from `this.worlds`. */
  _renderWorlds() {
    const list = this._worldListEl;
    if (!list) return;
    empty(list);
    if (!this.worlds.length) {
      const none = el('div', 'mc-hint', list);
      none.style.padding = 'var(--u6)';
      none.textContent = 'No saved worlds yet. Create one to get started.';
      this._syncWorldButtons();
      return;
    }
    for (const w of this.worlds) {
      const item = el('div', 'world-item', list);
      item.tabIndex = 0;
      item.setAttribute('role', 'option');
      item.dataset.world = w.name;
      if (w.name === this.selectedWorld) {
        item.classList.add('selected');
        item.setAttribute('aria-selected', 'true');
      }

      const icon = el('div', 'world-icon', item);
      if (w.thumbnail && typeof w.thumbnail === 'string' && w.thumbnail.slice(0, 5) === 'data:') {
        const img = document.createElement('img');
        img.src = w.thumbnail;
        img.alt = '';
        img.className = 'pixel';
        icon.appendChild(img);
      }

      const col = el('div', 'mc-col', item);
      col.style.cssText = 'gap:0;min-width:0;flex:1 1 auto;';
      el('div', 'world-name', col, w.name);
      el('div', 'world-meta', col,
        `${relativeTime(w.lastPlayed || w.played || w.created)} • ${modeLabel(w.mode)}` +
        ` • ${difficultyLabel(w.difficulty)}`);
      el('div', 'world-meta', col, `Seed: ${w.seed}`);

      const select = () => {
        this.selectedWorld = w.name;
        for (const n of list.querySelectorAll('.world-item')) {
          const on = n.dataset.world === w.name;
          n.classList.toggle('selected', on);
          n.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        this._syncWorldButtons();
      };
      item.addEventListener('click', () => { click(); select(); });
      item.addEventListener('dblclick', () => { select(); this._playSelected(); });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          select();
          if (e.key === 'Enter') this._playSelected();
        }
      });
      item.addEventListener('focus', select);
    }
    this._syncWorldButtons();
  }

  /** Enables the per-world buttons only when something is selected. */
  _syncWorldButtons() {
    const b = this._worldButtons;
    if (!b) return;
    const on = !!this.selectedWorld;
    for (const key of ['playBtn', 'recreateBtn', 'deleteBtn']) {
      const btn = b[key];
      if (!btn) continue;
      btn.disabled = !on;
      btn.classList.toggle('disabled', !on);
    }
  }

  /** The metadata row for the current selection, or null. */
  _selectedMeta() {
    return this.worlds.find((w) => w.name === this.selectedWorld) || null;
  }

  _playSelected() {
    const meta = this._selectedMeta();
    if (!meta) return;
    const mc = api();
    if (!mc || typeof mc.loadSavedWorld !== 'function') {
      tryCall(() => Game.log('Loading worlds is unavailable right now.'), null);
      return;
    }
    this.hide();
    Promise.resolve(tryCall(() => mc.loadSavedWorld(meta.name), null)).catch((err) => {
      console.error('[menu] loadSavedWorld', err);
      this.showWorldSelect();
    });
  }

  _recreateSelected() {
    const meta = this._selectedMeta();
    if (!meta) return;
    this.showCreateWorld({
      name: this._uniqueName(meta.name),
      seed: String(meta.seed),
      mode: meta.mode,
      difficulty: meta.difficulty,
    });
  }

  _deleteSelected() {
    const meta = this._selectedMeta();
    if (!meta) return;
    this._confirm(`Delete "${meta.name}"?`, [
      'The world and everything in it will be gone.',
      'This cannot be undone.',
    ], 'Delete', async () => {
      const save = Game.save;
      if (save && typeof save.deleteWorld === 'function') {
        try { await save.deleteWorld(meta.name); } catch (e) { console.error('[menu] deleteWorld', e); }
      }
      this.selectedWorld = null;
      await this._loadWorlds().catch(() => {});
    }, { danger: true, focusCancel: true });
  }

  /** "New World", "New World (2)", ... avoiding names already on disk. */
  _uniqueName(base) {
    const taken = new Set(this.worlds.map((w) => w.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  // =========================================================================
  // Create world
  // =========================================================================

  /**
   * The world-creation form. Every field is live: changing the seed repaints
   * the terrain preview immediately.
   * @param {{name?:string, seed?:string, mode?:string, difficulty?:number}} [preset]
   */
  showCreateWorld(preset = {}) {
    this._pauseGame();
    const cfg = {
      name: preset.name || this._uniqueName('New World'),
      seed: preset.seed === undefined || preset.seed === null ? '' : String(preset.seed),
      mode: preset.mode || GAMEMODE.SURVIVAL,
      difficulty: preset.difficulty === undefined
        ? tryCall(() => Game.settings.get('difficulty'), DIFFICULTY.NORMAL)
        : preset.difficulty,
      structures: preset.structures === undefined ? true : !!preset.structures,
      bonusChest: !!preset.bonusChest,
    };
    if (cfg.difficulty === undefined || cfg.difficulty === null) cfg.difficulty = DIFFICULTY.NORMAL;

    this._open('create', (host) => {
      const bg = el('div', 'menu-bg', host);
      el('h2', 'mc-title', bg, 'Create New World');

      const body = el('div', 'mc-row', bg);
      body.style.cssText = 'align-items:flex-start;gap:var(--u8);flex-wrap:wrap;justify-content:center;';

      // ---- form ----------------------------------------------------------
      const form = el('div', 'mc-panel dark', body);
      form.style.cssText = 'display:flex;flex-direction:column;gap:var(--u4);' +
        'padding:var(--u6);width:calc(var(--gs) * 210px);max-width:100%;';

      const nameRow = el('div', 'mc-col', form);
      nameRow.style.gap = 'var(--u2)';
      el('div', 'mc-label', nameRow, 'World Name');
      const nameField = this._input(cfg.name, {
        label: 'World name', maxLength: 48, placeholder: 'New World',
        onInput: (v) => { cfg.name = v; },
      });
      nameRow.appendChild(nameField);

      const seedRow = el('div', 'mc-col', form);
      seedRow.style.gap = 'var(--u2)';
      el('div', 'mc-label', seedRow, 'Seed for the World Generator');
      const seedField = this._input(cfg.seed, {
        label: 'World seed', maxLength: 64,
        placeholder: 'Leave blank for a random seed',
        onInput: (v) => { cfg.seed = v; schedulePreview(); },
      });
      seedRow.appendChild(seedField);
      const seedHint = el('div', 'mc-hint', seedRow, ' ');

      el('div', 'mc-divider', form);

      const rowMode = el('div', 'settings-row', form);
      el('div', 'mc-label', rowMode, 'Game Mode');
      const modeEntry = {
        label: 'Game Mode', type: 'select', options: GAMEMODE_OPTIONS,
        format: (v) => modeLabel(v), hint: '',
      };
      const modeBtn = this._cycler(modeEntry, () => cfg.mode, (v) => {
        cfg.mode = v;
        const o = GAMEMODE_OPTIONS.find((m) => m.value === v);
        modeHint.textContent = o ? o.hint : '';
      });
      rowMode.appendChild(modeBtn);
      const modeHint = el('div', 'mc-hint', form,
        (GAMEMODE_OPTIONS.find((m) => m.value === cfg.mode) || GAMEMODE_OPTIONS[0]).hint);

      const rowDiff = el('div', 'settings-row', form);
      el('div', 'mc-label', rowDiff, 'Difficulty');
      const diffEntry = {
        label: 'Difficulty', type: 'select', options: DIFFICULTY_OPTIONS,
        format: (v) => difficultyLabel(v), hint: '',
      };
      const diffBtn = this._cycler(diffEntry, () => cfg.difficulty, (v) => {
        cfg.difficulty = v;
        const o = DIFFICULTY_OPTIONS.find((d) => d.value === v);
        diffHint.textContent = o ? o.hint : '';
      });
      rowDiff.appendChild(diffBtn);
      const diffHint = el('div', 'mc-hint', form,
        (DIFFICULTY_OPTIONS.find((d) => d.value === cfg.difficulty) || DIFFICULTY_OPTIONS[2]).hint);

      el('div', 'mc-divider', form);

      const boolEntry = (label) => ({
        label, type: 'toggle', options: null,
        format: (v) => (v ? 'On' : 'Off'), hint: '',
      });

      const rowStruct = el('div', 'settings-row', form);
      el('div', 'mc-label', rowStruct, 'Generate Structures');
      rowStruct.appendChild(this._cycler(boolEntry('Generate Structures'),
        () => cfg.structures, (v) => { cfg.structures = !!v; }));

      const rowBonus = el('div', 'settings-row', form);
      el('div', 'mc-label', rowBonus, 'Bonus Chest');
      rowBonus.appendChild(this._cycler(boolEntry('Bonus Chest'),
        () => cfg.bonusChest, (v) => { cfg.bonusChest = !!v; }));

      // ---- preview -------------------------------------------------------
      const side = el('div', 'mc-col', body);
      side.style.cssText = 'gap:var(--u2);align-items:center;';
      el('div', 'mc-label', side, 'Terrain Preview');
      const frame = el('div', null, side);
      frame.style.cssText =
        'padding:var(--u2);background:#101010;' +
        'box-shadow:inset var(--u) var(--u) 0 0 #000, 0 0 0 var(--u) #a0a0a0;';
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 80;
      canvas.className = 'pixel';
      canvas.style.cssText = 'display:block;width:calc(var(--gs) * 108px);height:calc(var(--gs) * 68px);';
      frame.appendChild(canvas);
      const previewHint = el('div', 'mc-hint', side, 'about 1.3 km across');
      const rerollRow = el('div', 'mc-row', side);
      rerollRow.appendChild(this._button('Random Seed', () => {
        cfg.seed = String((Math.random() * 0x7fffffff) >>> 0);
        seedField.value = cfg.seed;
        schedulePreview(true);
      }, { cls: 'small' }));

      // ---- actions -------------------------------------------------------
      const buttons = el('div', 'menu-buttons', bg);
      const rowGo = el('div', 'mc-row', buttons);
      rowGo.appendChild(this._button('Create New World', () => {
        this._createWorld(cfg);
      }, { cls: 'primary' }));
      rowGo.appendChild(this._button('Cancel', () => this.showWorldSelect()));

      // ---- live preview plumbing -----------------------------------------
      // A blank box means "roll one for me", but the number has to stay put
      // between keystrokes or the preview would show terrain you never get.
      let timer = 0;
      const resolveSeed = () => {
        const text = cfg.seed.trim();
        if (text !== '') { cfg.randomSeed = null; return parseSeed(text); }
        if (cfg.randomSeed == null) cfg.randomSeed = (Math.random() * 0x7fffffff) >>> 0;
        return cfg.randomSeed;
      };
      const schedulePreview = (now) => {
        const seedNum = resolveSeed();
        cfg.resolvedSeed = seedNum;
        seedHint.textContent = cfg.seed.trim() === ''
          ? `Random seed: ${seedNum}`
          : `Seed value: ${seedNum}`;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = 0; this._drawPreview(canvas, seedNum, previewHint); },
          now ? 0 : 180);
      };
      this._onCleanup(() => { if (timer) clearTimeout(timer); });
      schedulePreview(true);

      this._footer(host);
    });
  }

  /**
   * Paints the tiny heightmap preview. Uses worldgen's `heightmapPreview` when
   * it loads, and a small local fBm otherwise so the box is never empty.
   */
  async _drawPreview(canvas, seed, hintEl) {
    if (!canvas || !canvas.getContext) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const W = canvas.width, H = canvas.height;
    const scale = 10;      // world blocks per preview pixel

    let heights = null;
    try {
      const wg = await import('../world/worldgen.js');
      if (wg && typeof wg.heightmapPreview === 'function') {
        heights = wg.heightmapPreview(seed, -(W * scale) / 2, -(H * scale) / 2, W, H, scale);
      }
    } catch (e) { heights = null; }
    if (!heights) heights = fallbackHeights(seed, W, H, scale);
    if (hintEl) {
      hintEl.textContent = `${Math.round(W * scale / 100) / 10} km across`;
    }

    const img = g.createImageData(W, H);
    const px = img.data;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const h = heights[k];
        // Cheap hill shading from the west neighbour makes ridges readable.
        const left = i > 0 ? heights[k - 1] : h;
        const shade = clamp(1 + (h - left) * 0.06, 0.7, 1.3);
        const c = terrainColor(h);
        const o = k * 4;
        px[o] = clamp(c[0] * shade, 0, 255);
        px[o + 1] = clamp(c[1] * shade, 0, 255);
        px[o + 2] = clamp(c[2] * shade, 0, 255);
        px[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  /** Hands the finished settings to main.js and drops into the world. */
  _createWorld(cfg) {
    const mc = api();
    const name = (cfg.name || '').trim() || 'New World';
    if (!mc || typeof mc.startNewWorld !== 'function') {
      tryCall(() => Game.log('World creation is unavailable: main.js did not finish booting.'), null);
      return;
    }
    tryCall(() => Game.settings && Game.settings.set('difficulty', cfg.difficulty), null);
    // Pass the resolved number as a string: main.js parses digits verbatim, so
    // the world gets exactly the seed the preview drew.
    const seed = String(cfg.resolvedSeed != null ? cfg.resolvedSeed : parseSeed(cfg.seed));
    this.hide();
    Promise.resolve(tryCall(() => mc.startNewWorld({
      name,
      seed,
      mode: cfg.mode,
      difficulty: cfg.difficulty,
      generateStructures: cfg.structures,
      bonusChest: cfg.bonusChest,
    }), null)).catch((err) => {
      console.error('[menu] startNewWorld', err);
      this.showTitle();
    });
  }

  // =========================================================================
  // Pause
  // =========================================================================

  /** The in-world game menu. Dims the world instead of covering it in dirt. */
  showPause() {
    if (!Game.started) { this.showTitle(); return; }
    this._pauseGame();
    this._open('pause', (host) => {
      const bg = el('div', 'pause-screen', host);
      el('h2', 'mc-title big', bg, 'Game Menu');

      const buttons = el('div', 'menu-buttons', bg);
      buttons.appendChild(this._button('Back to Game', () => this.hide(), { cls: 'primary' }));

      const row = el('div', 'mc-row', buttons);
      row.appendChild(this._button('Options...', () => this.showSettings('pause')));
      row.appendChild(this._button('Statistics', () => this._showStats()));

      buttons.appendChild(this._button('Save and Quit to Title', () => this._saveAndQuit(), { cls: 'danger' }));

      const info = el('div', 'mc-col', bg);
      info.style.cssText = 'gap:var(--u2);align-items:center;margin-top:var(--u4);';
      const seedLine = el('div', 'mc-hint', info);
      const posLine = el('div', 'mc-hint', info);
      const worldLine = el('div', 'mc-hint', info);

      // A slow poll keeps the coordinates honest without pinning a frame.
      const refresh = () => {
        const p = Game.player;
        const w = Game.world;
        seedLine.textContent = `World: ${Game.worldName || 'New World'}   Seed: ${Game.seed}`;
        if (p) {
          posLine.textContent =
            `XYZ: ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}` +
            `   Facing: ${facingName(p.yaw)}`;
        } else {
          posLine.textContent = 'XYZ: —';
        }
        const dim = DIMENSION_LABELS[Game.dimension] || prettyName(String(Game.dimension || 'overworld'));
        const time = w ? tryCall(() => formatTime(w.time), '--:--') : '--:--';
        const biome = (p && w) ? tryCall(() => {
          const b = w.biomeAt(Math.floor(p.x), Math.floor(p.z));
          return b && (b.display || prettyName(b.name));
        }, null) : null;
        worldLine.textContent =
          `${dim}   Time: ${time}   ${modeLabel(Game.mode)}` + (biome ? `   Biome: ${biome}` : '');
      };
      refresh();
      const timer = setInterval(refresh, 250);
      this._onCleanup(() => clearInterval(timer));

      const hint = el('div', 'mc-hint', bg);
      hint.textContent = 'Press Esc to return to the game';
    });
  }

  /** A small statistics panel over the pause screen. */
  _showStats() {
    const p = Game.player;
    const s = (p && p.stats) || {};
    const lines = [
      `Blocks mined: ${s.blocksMined || 0}`,
      `Blocks placed: ${s.blocksPlaced || 0}`,
      `Mobs killed: ${s.mobsKilled || 0}`,
      `Deaths: ${s.deaths || 0}`,
      `Distance walked: ${Math.round(s.distance || 0)} blocks`,
      `Jumps: ${s.jumps || 0}`,
      `Experience level: ${p ? (p.xpLevel | 0) : 0}`,
    ];
    this._confirm('Statistics', lines, 'Close', () => {}, { single: true });
  }

  /** Writes the world out and returns to the title screen. */
  _saveAndQuit() {
    const finish = () => {
      tryCall(() => Game.audio && Game.audio.stopMusic && Game.audio.stopMusic(0.5), null);
      Game.started = false;
      Game.paused = true;
      Game.gameOver = false;
      this.showTitle();
    };
    const save = Game.save;
    if (!save || typeof save.saveWorld !== 'function') { finish(); return; }
    // Show a beat of feedback: saving a big world is not instant.
    tryCall(() => Game.toast('Saving world…'), null);
    Promise.resolve(tryCall(() => save.saveWorld(Game, Game.worldName), null))
      .catch((err) => console.error('[menu] saveWorld', err))
      .then(finish);
  }

  // =========================================================================
  // Options
  // =========================================================================

  /**
   * Builds the whole options UI from SETTINGS_SCHEMA. Every change is written
   * straight through `Game.settings`, which validates, persists and emits
   * `settingschange` for the rest of the game to react to.
   * @param {string} [from] screen to return to ('title' | 'pause')
   */
  showSettings(from) {
    if (from) this.optionsReturn = from;
    else if (this.screen === 'pause' || this.screen === 'title') this.optionsReturn = this.screen;
    this._pauseGame();

    this._open('options', (host) => {
      const inGame = this.optionsReturn === 'pause' && Game.started;
      const bg = el('div', inGame ? 'pause-screen' : 'menu-bg', host);
      bg.style.gap = 'var(--u4)';
      el('h2', 'mc-title', bg, 'Options');

      // ---- tabs ----------------------------------------------------------
      const tabs = el('div', 'mc-row', bg);
      tabs.style.cssText = 'flex-wrap:wrap;justify-content:center;gap:var(--u2);';
      tabs.setAttribute('role', 'tablist');
      const allTabs = SETTINGS_CATEGORIES.concat([KEYBIND_TAB]);
      if (!allTabs.some((t) => t.id === this.optionsTab)) this.optionsTab = allTabs[0].id;

      const grid = el('div', 'settings-grid mc-scroll', bg);
      const warn = el('div', 'mc-hint', bg);
      warn.style.minHeight = 'var(--u8)';
      this._conflictLine = warn;

      const tabButtons = [];
      for (const t of allTabs) {
        const b = el('button', 'mc-tab top', tabs, t.label);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.addEventListener('click', () => {
          click();
          this.optionsTab = t.id;
          for (const other of tabButtons) {
            const on = other.dataset.tab === t.id;
            other.classList.toggle('active', on);
            other.setAttribute('aria-selected', on ? 'true' : 'false');
          }
          this._buildSettingsPage(grid);
        });
        b.dataset.tab = t.id;
        const on = t.id === this.optionsTab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        tabButtons.push(b);
      }

      this._buildSettingsPage(grid);

      // ---- footer --------------------------------------------------------
      const buttons = el('div', 'menu-buttons', bg);
      const row = el('div', 'mc-row', buttons);
      row.appendChild(this._button('Reset to Defaults', () => {
        this._confirm('Reset every option?', [
          'All video, control, audio and key settings go back to their defaults.',
        ], 'Reset', () => {
          tryCall(() => Game.settings && Game.settings.reset(), null);
          tryCall(() => {
            const gs = Game.settings.get('guiScale');
            document.documentElement.style.setProperty('--gui-scale', String(gs));
          }, null);
          this._syncAudioVolumes();
          this._buildSettingsPage(grid);
        }, { danger: true, focusCancel: true });
      }, { cls: 'small' }));
      row.appendChild(this._button('Done', () => this._leaveOptions(), { cls: 'primary' }));

      if (!inGame) this._footer(host);
    });
  }

  /** Escape / Done from the options screen. */
  _leaveOptions() {
    this._stopListening();
    if (this.optionsReturn === 'pause' && Game.started) this.showPause();
    else this.showTitle();
  }

  /** Fills the settings grid for the active tab. */
  _buildSettingsPage(grid) {
    empty(grid);
    this._stopListening();
    if (this._conflictLine) this._conflictLine.textContent = '';

    if (this.optionsTab === KEYBIND_TAB.id) {
      grid.classList.add('one-column');
      this._buildKeybindPage(grid);
      return;
    }
    grid.classList.remove('one-column');

    const entries = tryCall(() => schemaByCategory(this.optionsTab), []) || [];
    const plain = entries.filter((e) => e.type !== 'key');
    if (!plain.length) {
      el('div', 'mc-hint', grid, 'Nothing to configure here.');
      return;
    }
    const heading = (SETTINGS_CATEGORIES.find((c) => c.id === this.optionsTab) || {}).label;
    if (heading) el('div', 'settings-category', grid, heading);
    for (const entry of plain) this._settingsRow(grid, entry);

    if (this.optionsTab === 'controls') {
      const jump = el('div', 'settings-row', grid);
      el('div', 'mc-label', jump, 'Key Bindings');
      jump.appendChild(this._button('Configure…', () => {
        this.optionsTab = KEYBIND_TAB.id;
        const tab = this.host && this.host.querySelector('.mc-tab[data-tab="' + KEYBIND_TAB.id + '"]');
        if (tab) tab.click();
      }, { cls: 'small' }));
    }
  }

  /** One `.settings-row` for a schema entry, wired to live-apply. */
  _settingsRow(grid, entry) {
    const row = el('div', 'settings-row', grid);
    if (entry.hint) row.title = entry.hint;
    const label = el('div', 'mc-label', row, entry.label);
    label.id = 'opt-' + entry.key.replace(/[^a-z0-9]/gi, '-');

    const read = () => tryCall(() => Game.settings.get(entry.key), entry.def);
    const write = (v) => this._applySetting(entry.key, v);

    let control;
    if (entry.type === 'slider') control = this._slider(entry, read, write);
    else control = this._cycler(entry, read, write);
    control.setAttribute('aria-labelledby', label.id);
    row.appendChild(control);
    return row;
  }

  /**
   * Writes one option and applies the side effects `settingschange` listeners
   * elsewhere do not cover (audio gain, fullscreen, GUI scale).
   */
  _applySetting(key, value) {
    const s = Game.settings;
    if (!s || typeof s.set !== 'function') return;
    tryCall(() => s.set(key, value), null);
    const stored = tryCall(() => s.get(key), value);

    if (key.indexOf('volume.') === 0) {
      const cat = key.slice(7);
      tryCall(() => Game.audio && Game.audio.setVolume && Game.audio.setVolume(cat, stored), null);
      if (cat === 'master') this._syncAudioVolumes();
    } else if (key === 'guiScale') {
      tryCall(() => document.documentElement.style.setProperty('--gui-scale', String(stored)), null);
    } else if (key === 'fullscreen') {
      this._applyFullscreen(!!stored);
    } else if (key === 'fov') {
      tryCall(() => {
        if (!Game.camera) return;
        Game.camera.fov = stored;
        Game.camera.updateProjectionMatrix();
      }, null);
    } else if (key === 'renderDistance') {
      tryCall(() => Game.chunkRenderer && Game.chunkRenderer.setRenderDistance(stored), null);
    } else if (key === 'difficulty') {
      Game.difficulty = stored;
    }
  }

  /** Pushes every stored volume into the sound engine at once. */
  _syncAudioVolumes() {
    const s = Game.settings;
    const a = Game.audio;
    if (!s || !a || typeof a.setVolume !== 'function') return;
    const vols = tryCall(() => s.get('volume'), null);
    if (!vols) return;
    for (const cat of Object.keys(vols)) tryCall(() => a.setVolume(cat, vols[cat]), null);
  }

  /** Enters or leaves browser fullscreen, tolerating a refusal. */
  _applyFullscreen(on) {
    tryCall(() => {
      const doc = document;
      const isFull = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      if (on && !isFull) {
        const root = doc.documentElement;
        const req = root.requestFullscreen || root.webkitRequestFullscreen;
        if (req) { const p = req.call(root); if (p && p.catch) p.catch(() => {}); }
      } else if (!on && isFull) {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (exit) { const p = exit.call(doc); if (p && p.catch) p.catch(() => {}); }
      }
    }, null);
  }

  // -------------------------------------------------------------------------
  // Key bindings
  // -------------------------------------------------------------------------

  /** The rebinding page: every action grouped, plus a reset button. */
  _buildKeybindPage(grid) {
    const byGroup = new Map();
    const push = (g, entry) => {
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(entry);
    };
    for (const entry of SETTINGS_SCHEMA) {
      if (entry.type !== 'key') continue;
      push(entry.group || 'gameplay', entry);
    }
    if (!byGroup.size) {
      // The schema is the source of truth, but never show an empty page.
      for (const action of KEYBIND_ACTIONS) {
        push('gameplay', {
          key: 'keybinds.' + action,
          label: KEYBIND_LABELS[action] || prettyName(action),
          type: 'key', def: DEFAULT_KEYBINDS[action], format: keyLabel,
        });
      }
    }
    // Anything the settings module added without a listed group still shows.
    const order = KEYBIND_GROUP_LABELS.map((g) => g[0]);
    for (const g of byGroup.keys()) if (order.indexOf(g) < 0) order.push(g);

    this._keyRows = [];
    for (const g of order) {
      const entries = byGroup.get(g);
      if (!entries || !entries.length) continue;
      const pair = KEYBIND_GROUP_LABELS.find((k) => k[0] === g);
      el('div', 'settings-category', grid, pair ? pair[1] : prettyName(g));
      for (const entry of entries) this._keybindRow(grid, entry);
    }

    const foot = el('div', 'settings-row', grid);
    el('div', 'mc-label', foot, 'All bindings');
    foot.appendChild(this._button('Reset Keys', () => {
      this._confirm('Reset every key binding?', ['Movement, gameplay and interface keys go back to defaults.'],
        'Reset', () => {
          tryCall(() => Game.settings && Game.settings.resetKeybinds(), null);
          this._buildSettingsPage(grid);
        }, { danger: true, focusCancel: true });
    }, { cls: 'small' }));

    el('div', 'mc-hint', grid,
      'Click a binding, then press a key or mouse button. Esc cancels, Delete unbinds.');
    this._refreshConflicts();
  }

  /** One `.keybind-row`. Clicking the key button starts capture. */
  _keybindRow(grid, entry) {
    const action = entry.key.slice(entry.key.indexOf('.') + 1);
    const row = el('div', 'settings-row keybind-row', grid);
    const label = el('div', 'mc-label', row, entry.label || KEYBIND_LABELS[action] || prettyName(action));
    const code = tryCall(() => Game.settings.getKeybind(action), DEFAULT_KEYBINDS[action]) || '';
    const btn = this._button(keyLabel(code), () => this._startListening(action, btn, row), {
      cls: 'small keybind-key',
      title: 'Click, then press the key you want.',
    });
    btn.dataset.action = action;
    row.appendChild(btn);
    this._keyRows.push({ action, btn, row, label });
    return row;
  }

  /** Puts one binding into capture mode. */
  _startListening(action, btn, row) {
    this._stopListening();
    this._listening = { action, btn, row };
    btn.classList.add('listening');
    btn.textContent = '> ? <';
    this._disableGameInput();
    // Swallow the mouse buttons too, so binding "attack" to Mouse0 works.
    const onMouse = (e) => {
      if (!this._listening) return;
      e.preventDefault();
      e.stopPropagation();
      const names = ['Mouse0', 'Mouse1', 'Mouse2', 'Mouse3', 'Mouse4'];
      this._commitBinding(names[e.button] || ('Mouse' + e.button));
    };
    const onWheel = (e) => {
      if (!this._listening) return;
      e.preventDefault();
      this._commitBinding(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
    };
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    this._listenCleanup = () => {
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('wheel', onWheel, true);
    };
  }

  /** Handles the keydown that lands while capture is armed. */
  _captureBinding(e) {
    e.preventDefault();
    e.stopPropagation();
    const code = e.code || e.key;
    if (code === 'Escape') { this._stopListening(); return; }
    if (code === 'Delete' || code === 'Backspace') { this._commitBinding(''); return; }
    this._commitBinding(code);
  }

  /** Stores the captured code and repaints conflicts. */
  _commitBinding(code) {
    const state = this._listening;
    if (!state) return;
    const { action } = state;
    // clearConflicts = false: we warn about clashes instead of silently
    // unbinding the other action, and show which ones clash in red.
    tryCall(() => Game.settings.setKeybind(action, code, false), null);
    this._stopListening();
    this._refreshKeyLabels();
    this._refreshConflicts();
  }

  /** Leaves capture mode without changing anything. */
  _stopListening() {
    if (this._listenCleanup) { tryCall(this._listenCleanup, null); this._listenCleanup = null; }
    const state = this._listening;
    this._listening = null;
    this._enableGameInput();
    if (!state) return;
    state.btn.classList.remove('listening');
    const code = tryCall(() => Game.settings.getKeybind(state.action), '') || '';
    state.btn.textContent = keyLabel(code);
  }

  /** Rewrites every key button's caption from the stored bindings. */
  _refreshKeyLabels() {
    for (const r of this._keyRows || []) {
      const code = tryCall(() => Game.settings.getKeybind(r.action), '') || '';
      r.btn.textContent = keyLabel(code);
    }
  }

  /** Marks clashing bindings red and explains the first clash underneath. */
  _refreshConflicts() {
    const rows = this._keyRows || [];
    if (!rows.length) return;
    const used = new Map();
    for (const r of rows) {
      const code = tryCall(() => Game.settings.getKeybind(r.action), '') || '';
      if (!code) continue;
      if (!used.has(code)) used.set(code, []);
      used.get(code).push(r);
    }
    let firstClash = null;
    for (const r of rows) r.btn.classList.remove('conflict');
    for (const [code, list] of used) {
      if (list.length < 2) continue;
      for (const r of list) r.btn.classList.add('conflict');
      if (!firstClash) firstClash = { code, list };
    }
    const line = this._conflictLine;
    if (!line) return;
    if (!firstClash) { line.textContent = ''; line.classList.remove('mc-c-red'); return; }
    const names = firstClash.list.map((r) => r.label.textContent).join(', ');
    line.textContent = `${keyLabel(firstClash.code)} is bound to ${names}.`;
    line.classList.add('mc-c-red');
  }

  // =========================================================================
  // Death
  // =========================================================================

  /** "You Died!" with the cause, the score and the two ways out. */
  showDeath(source) {
    this._pauseGame();
    Game.gameOver = true;
    const p = Game.player;
    const src = source || (p && p.lastDamageSource) || null;
    let message = 'You died.';
    if (p && typeof p.deathMessage === 'function') {
      message = tryCall(() => p.deathMessage(src), message) || message;
    } else if (src && src.type) {
      message = `Killed by ${prettyName(String(src.type))}`;
    }
    const score = Math.max(0, this.lastScore | 0);

    this._open('death', (host) => {
      const screen = el('div', 'death-screen', host);
      el('h1', 'death-title', screen, 'You Died!');
      el('div', 'death-message', screen, message);
      el('div', 'death-score', screen, `Score: ${score}`);

      const buttons = el('div', 'menu-buttons', screen);
      buttons.appendChild(this._button('Respawn', () => this._respawn(), { cls: 'primary' }));
      buttons.appendChild(this._button('Title Screen', () => {
        this._confirm('Give up on this world?', ['Your world is saved; you can load it again later.'],
          'Title Screen', () => this._saveAndQuit(), { focusCancel: true });
      }));
      const hard = el('div', 'mc-hint', screen);
      hard.textContent = tryCall(() => (Game.difficulty === DIFFICULTY.HARD
        ? 'Hard mode: hunger can finish the job next time.'
        : 'Tip: your items are on the ground where you fell.'), '');
    });
  }

  /** Puts the player back on their feet and returns to the game. */
  _respawn() {
    const p = Game.player;
    Game.gameOver = false;
    this.lastScore = 0;
    if (p && typeof p.respawn === 'function') {
      const ok = tryCall(() => { p.respawn(); return true; }, false);
      if (!ok) console.warn('[menu] respawn failed');
    }
    Game.started = true;
    this.hide();
  }

  // =========================================================================
  // Win / end credits
  // =========================================================================

  /**
   * The end-poem-style credits roll. Scrolls on its own, speeds up while a
   * key or the mouse is held, and can be skipped at any time.
   * @param {boolean} [fromTitle] true when opened from the title screen
   */
  showWin(fromTitle = false) {
    this._creditsFromTitle = !!fromTitle || !Game.started;
    this._pauseGame();
    this._open('win', (host) => {
      const screen = el('div', null, host);
      screen.style.cssText =
        'position:absolute;inset:0;overflow:hidden;background:#000;pointer-events:auto;' +
        'display:block;';

      const stars = el('div', null, screen);
      stars.style.cssText =
        'position:absolute;inset:0;opacity:0.5;' +
        'background-image:radial-gradient(1px 1px at 20% 30%, #fff, transparent),' +
        'radial-gradient(1px 1px at 70% 60%, #cbe, transparent),' +
        'radial-gradient(1px 1px at 45% 80%, #fff, transparent),' +
        'radial-gradient(1px 1px at 85% 20%, #9af, transparent);' +
        'background-size:220px 220px, 300px 300px, 180px 180px, 260px 260px;';

      const scroller = el('div', null, screen);
      scroller.style.cssText =
        'position:absolute;left:50%;top:0;transform:translate(-50%, 0);' +
        'width:min(calc(var(--gs) * 220px), 92vw);will-change:transform;';

      const name = tryCall(() => (Game.player && Game.player.name) || 'PLAYER', 'PLAYER');
      for (const line of END_POEM) {
        const cls = line.c ? 'mc-c-' + line.c : '';
        const d = el('div', cls, scroller, line.t.replace(/PLAYERNAME/g, name) || ' ');
        d.style.cssText = 'line-height:1.9;text-align:center;text-shadow:var(--mc-shadow);' +
          'font-size:var(--fs);white-space:pre-wrap;';
      }

      const skip = el('div', 'menu-buttons', screen);
      skip.style.cssText =
        'position:absolute;left:50%;bottom:var(--u8);transform:translateX(-50%);width:auto;z-index:2;';
      const skipRow = el('div', 'mc-row', skip);
      skipRow.appendChild(this._button('Skip', () => this._endCredits(), { cls: 'small' }));
      const hint = el('div', 'mc-hint', skip);
      hint.style.textAlign = 'center';
      hint.textContent = 'Hold any key to scroll faster • Esc to skip';

      // ---- the roll ------------------------------------------------------
      const vh = () => (screen.clientHeight || window.innerHeight || 600);
      let y = vh();
      let last = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let fast = false;
      const onDown = () => { fast = true; };
      const onUp = () => { fast = false; };
      window.addEventListener('keydown', onDown);
      window.addEventListener('keyup', onUp);
      screen.addEventListener('pointerdown', onDown);
      window.addEventListener('pointerup', onUp);
      this._onCleanup(() => {
        window.removeEventListener('keydown', onDown);
        window.removeEventListener('keyup', onUp);
        window.removeEventListener('pointerup', onUp);
      });

      // Measured once: reading offsetHeight every frame would force a layout.
      let rollHeight = scroller.offsetHeight || END_POEM.length * 24;
      const step = () => {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        y -= (fast ? 190 : 34) * dt;
        scroller.style.transform = `translate(-50%, ${y.toFixed(1)}px)`;
        if (y + rollHeight < -40) {
          // Re-measure once before giving up: fonts may have landed late.
          rollHeight = scroller.offsetHeight || rollHeight;
          if (y + rollHeight < -40) { this._endCredits(); return; }
        }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    });
  }

  /** Leaves the credits: back to the game if there is one, else the title. */
  _endCredits() {
    if (this._creditsFromTitle || !Game.started) this.showTitle();
    else this.hide();
  }
}

// ---------------------------------------------------------------------------
// Preview helpers (module scope so they are hoisted above their first use)
// ---------------------------------------------------------------------------

/** Compass name for a yaw in radians, matching the F3 overlay's convention. */
function facingName(yaw) {
  const deg = ((-(yaw || 0) * 180 / Math.PI) % 360 + 360) % 360;
  if (deg < 45 || deg >= 315) return 'north';
  if (deg < 135) return 'east';
  if (deg < 225) return 'south';
  return 'west';
}

/** Smooth value noise in [0,1) from the shared hash, for the preview fallback. */
function valueNoise(seed, x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const tx = x - xi, tz = z - zi;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hashFloat(seed, xi, 0, zi);
  const b = hashFloat(seed, xi + 1, 0, zi);
  const c = hashFloat(seed, xi, 0, zi + 1);
  const d = hashFloat(seed, xi + 1, 0, zi + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}

/**
 * A stand-in heightmap used only when `world/worldgen.js` cannot be imported.
 * It is not the real terrain, but it keeps the preview box alive.
 */
function fallbackHeights(seed, w, h, scale) {
  const out = new Uint8Array(w * h);
  const s = seed >>> 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = (i - w / 2) * scale, z = (j - h / 2) * scale;
      let amp = 1, freq = 1 / 220, sum = 0, norm = 0;
      for (let o = 0; o < 5; o++) {
        sum += valueNoise(s + o * 7919, x * freq, z * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.05;
      }
      const n = sum / norm;
      // Push the distribution towards flat land with occasional peaks.
      const shaped = Math.pow(n, 1.35);
      out[j * w + i] = clamp(Math.round(38 + shaped * 78), 0, 255);
    }
  }
  return out;
}

/** Maps a surface height to a preview colour: ocean, beach, land, rock, snow. */
function terrainColor(h) {
  if (h < SEA_LEVEL - 22) return [17, 32, 84];
  if (h < SEA_LEVEL - 8) return [26, 52, 122];
  if (h < SEA_LEVEL) return [40, 82, 165];
  if (h <= SEA_LEVEL + 1) return [214, 202, 148];
  if (h < SEA_LEVEL + 6) return [122, 168, 84];
  if (h < SEA_LEVEL + 16) return [96, 146, 66];
  if (h < SEA_LEVEL + 26) return [82, 122, 56];
  if (h < SEA_LEVEL + 36) return [116, 112, 96];
  if (h < SEA_LEVEL + 48) return [146, 144, 142];
  return [236, 240, 246];
}

export default Menu;
