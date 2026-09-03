// ============================================================================
// game.js - The central service locator and shared mutable state.
//
// IMPORTANT RULE FOR ALL MODULES:
//   Import `Game` freely, but NEVER read Game.<field> at module-evaluation time.
//   Only touch its fields inside functions that run after boot. This keeps the
//   module graph free of initialization-order hazards even when imports cycle.
// ============================================================================
import { GAMEMODE, DIFFICULTY, DIM_OVERWORLD } from './constants.js';

export const Game = {
  // --- three.js plumbing (set by main.js) ---
  renderer: null,          // THREE.WebGLRenderer
  scene: null,             // THREE.Scene for the active dimension
  camera: null,            // THREE.PerspectiveCamera
  clock: null,

  // --- world & entities ---
  worlds: Object.create(null),   // dimension name -> World
  world: null,                   // active World
  player: null,                  // Player entity
  seed: 0,
  worldName: 'New World',

  // --- subsystems (each registers itself during boot) ---
  atlas: null,        // { texture, uv(name), tileIndex(name), canvas }
  chunkRenderer: null,
  entityRenderer: null,
  particles: null,
  sky: null,
  audio: null,
  input: null,
  settings: null,
  ui: null,           // { hud, screens, menu, chat, debug }
  save: null,

  // --- session state ---
  mode: GAMEMODE.SURVIVAL,
  difficulty: DIFFICULTY.NORMAL,
  dimension: DIM_OVERWORLD,
  paused: true,
  running: false,
  started: false,
  ticks: 0,             // total ticks elapsed this session
  frame: 0,
  dt: 0,                // seconds since last frame (clamped)
  time: 0,              // seconds since boot
  cheats: true,
  gameOver: false,

  // --- performance counters, surfaced by the F3 overlay ---
  stats: {
    fps: 0, frameMs: 0, drawCalls: 0, triangles: 0,
    chunksLoaded: 0, chunksRendered: 0, chunksQueued: 0, meshMs: 0, genMs: 0,
    entities: 0, entitiesRendered: 0, tickMs: 0,
  },

  // --- simple event bus -----------------------------------------------------
  _handlers: new Map(),
  on(event, fn) {
    let a = this._handlers.get(event);
    if (!a) { a = []; this._handlers.set(event, a); }
    a.push(fn);
    return () => this.off(event, fn);
  },
  off(event, fn) {
    const a = this._handlers.get(event);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  },
  once(event, fn) {
    const off = this.on(event, (...args) => { off(); fn(...args); });
    return off;
  },
  emit(event, ...args) {
    const a = this._handlers.get(event);
    if (!a) return;
    for (let i = 0; i < a.length; i++) {
      try { a[i](...args); } catch (e) { console.error(`[event:${event}]`, e); }
    }
  },

  // --- convenience ----------------------------------------------------------
  isCreative() { return this.mode === GAMEMODE.CREATIVE; },
  isSpectator() { return this.mode === GAMEMODE.SPECTATOR; },
  isSurvival() { return this.mode === GAMEMODE.SURVIVAL || this.mode === GAMEMODE.ADVENTURE; },
  isPeaceful() { return this.difficulty === DIFFICULTY.PEACEFUL; },

  /** Push a transient message to the action bar above the hotbar. */
  toast(text) { this.emit('toast', text); },
  /** Push a line into the chat log. */
  log(text) { this.emit('chat', text); },
};

// Handy for debugging from the browser console.
if (typeof window !== 'undefined') window.Game = Game;

/**
 * Standard event names emitted through Game.emit. Listed here so every module
 * agrees on spelling.
 *
 *  'boot'                       - subsystems constructed, world not yet created
 *  'worldloaded'   (world)      - a world became active
 *  'dimensionchange' (from,to)  - player moved between dimensions
 *  'tick'          (tickCount)  - once per 1/20s simulation step
 *  'blockchange'   (x,y,z,old,new)
 *  'blockbreak'    (x,y,z,blockId,player)
 *  'blockplace'    (x,y,z,blockId,player)
 *  'entityspawn'   (entity)
 *  'entityremove'  (entity)
 *  'entitydeath'   (entity, source)
 *  'playerhurt'    (amount, source)
 *  'playerdeath'   (source)
 *  'playerrespawn' ()
 *  'itempickup'    (stack)
 *  'craft'         (stack)
 *  'chat'          (text)
 *  'toast'         (text)
 *  'openscreen'    (name)
 *  'closescreen'   (name)
 *  'pause' / 'resume'
 *  'settingschange'(key, value)
 *  'achievement'   (id, title)
 */
export const EVENTS = Object.freeze([
  'boot', 'worldloaded', 'dimensionchange', 'tick', 'blockchange', 'blockbreak', 'blockplace',
  'entityspawn', 'entityremove', 'entitydeath', 'playerhurt', 'playerdeath', 'playerrespawn',
  'itempickup', 'craft', 'chat', 'toast', 'openscreen', 'closescreen', 'pause', 'resume',
  'settingschange', 'achievement',
]);

export default Game;
