// ============================================================================
// settings.js - Game options, validation, localStorage persistence, keybinds.
//
// Everything the options screen shows is described once in OPTION_DEFS and
// re-exported as SETTINGS_SCHEMA, so the UI never hard-codes a range or a label.
// `Game` is imported but only ever touched inside methods (see game.js header).
// ============================================================================
import { Game } from './game.js';
import { clamp } from './util.js';
import {
  MIN_RENDER_DISTANCE, MAX_RENDER_DISTANCE, DEFAULT_RENDER_DISTANCE,
  SOUND_CATEGORIES, DIFFICULTY,
} from './constants.js';

/** localStorage key holding the serialized settings blob. */
export const STORAGE_KEY = 'mc67.settings';

// ---------------------------------------------------------------------------
// Keybinds
// ---------------------------------------------------------------------------

/**
 * Default action -> KeyboardEvent.code (or 'Mouse0'/'Mouse1'/'Mouse2'/
 * 'MouseMiddle'/'WheelUp'/'WheelDown') mapping. Input.isDown('forward') looks
 * actions up in here (or in the user's overridden copy).
 */
export const DEFAULT_KEYBINDS = Object.freeze({
  // movement
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  // gameplay
  attack: 'Mouse0',
  use: 'Mouse2',
  pickBlock: 'MouseMiddle',
  drop: 'KeyQ',
  dropStack: 'ControlLeft+KeyQ',
  offhand: 'KeyF',
  // interface
  inventory: 'KeyE',
  recipeBook: 'KeyB',
  advancements: 'KeyL',
  chat: 'KeyT',
  command: 'Slash',
  list: 'Tab',
  perspective: 'F5',
  debug: 'F3',
  screenshot: 'F2',
  hidegui: 'F1',
  fullscreen: 'F11',
  zoom: 'KeyC',
  pause: 'Escape',
  // hotbar
  hotbar1: 'Digit1',
  hotbar2: 'Digit2',
  hotbar3: 'Digit3',
  hotbar4: 'Digit4',
  hotbar5: 'Digit5',
  hotbar6: 'Digit6',
  hotbar7: 'Digit7',
  hotbar8: 'Digit8',
  hotbar9: 'Digit9',
});

/** Human labels for every bindable action, in the order the options screen lists them. */
export const KEYBIND_LABELS = Object.freeze({
  forward: 'Walk Forwards',
  back: 'Walk Backwards',
  left: 'Strafe Left',
  right: 'Strafe Right',
  jump: 'Jump',
  sneak: 'Sneak',
  sprint: 'Sprint',
  attack: 'Attack / Destroy',
  use: 'Use Item / Place Block',
  pickBlock: 'Pick Block',
  drop: 'Drop Selected Item',
  dropStack: 'Drop Item Stack',
  offhand: 'Swap Item With Offhand',
  inventory: 'Open / Close Inventory',
  recipeBook: 'Recipe Book',
  advancements: 'Advancements',
  chat: 'Open Chat',
  command: 'Open Command',
  list: 'List Players',
  perspective: 'Toggle Perspective',
  debug: 'Debug Info',
  screenshot: 'Take Screenshot',
  hidegui: 'Toggle HUD',
  fullscreen: 'Toggle Fullscreen',
  zoom: 'Zoom',
  pause: 'Pause / Back',
  hotbar1: 'Hotbar Slot 1',
  hotbar2: 'Hotbar Slot 2',
  hotbar3: 'Hotbar Slot 3',
  hotbar4: 'Hotbar Slot 4',
  hotbar5: 'Hotbar Slot 5',
  hotbar6: 'Hotbar Slot 6',
  hotbar7: 'Hotbar Slot 7',
  hotbar8: 'Hotbar Slot 8',
  hotbar9: 'Hotbar Slot 9',
});

/** Which sub-heading each action belongs under in the controls screen. */
export const KEYBIND_GROUPS = Object.freeze({
  forward: 'movement', back: 'movement', left: 'movement', right: 'movement',
  jump: 'movement', sneak: 'movement', sprint: 'movement',
  attack: 'gameplay', use: 'gameplay', pickBlock: 'gameplay', drop: 'gameplay',
  dropStack: 'gameplay', offhand: 'gameplay',
  inventory: 'interface', recipeBook: 'interface', advancements: 'interface',
  chat: 'interface', command: 'interface', list: 'interface',
  perspective: 'interface', debug: 'interface', screenshot: 'interface',
  hidegui: 'interface', fullscreen: 'interface', zoom: 'interface', pause: 'interface',
  hotbar1: 'hotbar', hotbar2: 'hotbar', hotbar3: 'hotbar', hotbar4: 'hotbar',
  hotbar5: 'hotbar', hotbar6: 'hotbar', hotbar7: 'hotbar', hotbar8: 'hotbar',
  hotbar9: 'hotbar',
});

/** Every bindable action name, in display order. */
export const KEYBIND_ACTIONS = Object.freeze(Object.keys(DEFAULT_KEYBINDS));

// ---- Key code -> pretty label ---------------------------------------------

const MOUSE_LABELS = {
  Mouse0: 'Left Button',
  Mouse1: 'Middle Button',
  Mouse2: 'Right Button',
  Mouse3: 'Button 4',
  Mouse4: 'Button 5',
  MouseLeft: 'Left Button',
  MouseMiddle: 'Middle Button',
  MouseRight: 'Right Button',
  WheelUp: 'Scroll Up',
  WheelDown: 'Scroll Down',
};

const SPECIAL_LABELS = {
  '': 'None',
  Escape: 'Esc',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  ContextMenu: 'Menu',
  PrintScreen: 'Print Screen',
  ScrollLock: 'Scroll Lock',
  Pause: 'Pause',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ArrowUp: 'Up Arrow',
  ArrowDown: 'Down Arrow',
  ArrowLeft: 'Left Arrow',
  ArrowRight: 'Right Arrow',
  NumLock: 'Num Lock',
  IntlBackslash: '\\',
  IntlRo: '\\',
  IntlYen: '¥',
};

const PUNCTUATION_LABELS = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: '\'', Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /', NumpadDecimal: 'Num .', NumpadEqual: 'Num =',
  NumpadComma: 'Num ,',
};

const SIDE_LABELS = {
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt', AltRight: 'Right Alt',
  MetaLeft: 'Left Meta', MetaRight: 'Right Meta',
  OSLeft: 'Left Meta', OSRight: 'Right Meta',
};

/**
 * Turns a stored key code into something a human can read.
 * 'KeyW' -> 'W', 'ShiftLeft' -> 'Left Shift', 'Mouse0' -> 'Left Button',
 * 'ControlLeft+KeyQ' -> 'Left Ctrl + Q'.
 */
export function keyLabel(code) {
  if (code === null || code === undefined || code === '') return 'None';
  const str = String(code);
  // Chords are stored joined by '+'.
  if (str.length > 1 && str.includes('+')) {
    return str.split('+').map((p) => keyLabel(p.trim())).join(' + ');
  }
  if (MOUSE_LABELS[str]) return MOUSE_LABELS[str];
  if (SIDE_LABELS[str]) return SIDE_LABELS[str];
  if (SPECIAL_LABELS[str]) return SPECIAL_LABELS[str];
  if (PUNCTUATION_LABELS[str]) return PUNCTUATION_LABELS[str];
  if (/^Key[A-Z]$/.test(str)) return str.slice(3);
  if (/^Digit[0-9]$/.test(str)) return str.slice(5);
  if (/^Numpad[0-9]$/.test(str)) return 'Num ' + str.slice(6);
  if (/^F\d{1,2}$/.test(str)) return str;
  if (/^Mouse\d+$/.test(str)) return 'Button ' + (Number(str.slice(5)) + 1);
  // Fallback: split CamelCase into words ("MediaPlayPause" -> "Media Play Pause").
  return str.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^\s+|\s+$/g, '');
}

// ---------------------------------------------------------------------------
// Option definitions -> SETTINGS_SCHEMA
// ---------------------------------------------------------------------------

const pct = (v) => Math.round(v * 100) + '%';
const onOff = (v) => (v ? 'On' : 'Off');

/** Per-category audio defaults. Music sits lower than everything else, like vanilla. */
const VOLUME_DEFAULTS = {
  master: 1, music: 0.6, blocks: 1, hostile: 1, neutral: 1, players: 1,
  ambient: 1, weather: 1,
};

const VOLUME_LABELS = {
  master: 'Master Volume', music: 'Music', blocks: 'Blocks',
  hostile: 'Hostile Creatures', neutral: 'Friendly Creatures', players: 'Players',
  ambient: 'Ambient / Environment', weather: 'Weather',
};

const PARTICLE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'decreased', label: 'Decreased' },
  { value: 'minimal', label: 'Minimal' },
];

const GUI_SCALE_OPTIONS = [
  { value: 0, label: 'Auto' },
  { value: 1, label: 'Small (1x)' },
  { value: 2, label: 'Normal (2x)' },
  { value: 3, label: 'Large (3x)' },
  { value: 4, label: 'Huge (4x)' },
];

const DIFFICULTY_OPTIONS = [
  { value: DIFFICULTY.PEACEFUL, label: 'Peaceful' },
  { value: DIFFICULTY.EASY, label: 'Easy' },
  { value: DIFFICULTY.NORMAL, label: 'Normal' },
  { value: DIFFICULTY.HARD, label: 'Hard' },
];

const CROSSHAIR_OPTIONS = [
  { value: 'cross', label: 'Cross' },
  { value: 'dot', label: 'Dot' },
  { value: 'circle', label: 'Circle' },
  { value: 'none', label: 'Hidden' },
];

/**
 * The single source of truth for every option: default value, type, range and
 * how it renders. `key` may be dotted ('volume.music', 'keybinds.forward').
 */
const OPTION_DEFS = [
  // ---- video -------------------------------------------------------------
  {
    key: 'renderDistance', label: 'Render Distance', type: 'slider', category: 'video',
    def: DEFAULT_RENDER_DISTANCE, min: MIN_RENDER_DISTANCE, max: MAX_RENDER_DISTANCE, step: 1,
    format: (v) => v + ' chunks',
    hint: 'How far chunks are generated and drawn. Lower it if the game stutters.',
  },
  {
    key: 'fov', label: 'FOV', type: 'slider', category: 'video',
    def: 70, min: 30, max: 110, step: 1,
    format: (v) => (v === 70 ? 'Normal' : v === 110 ? 'Quake Pro' : String(v)),
  },
  {
    key: 'brightness', label: 'Brightness', type: 'slider', category: 'video',
    def: 0.5, min: 0, max: 1, step: 0.01,
    format: (v) => (v <= 0.001 ? 'Moody' : v >= 0.999 ? 'Bright' : pct(v)),
  },
  {
    key: 'guiScale', label: 'GUI Scale', type: 'select', category: 'video',
    def: 3, options: GUI_SCALE_OPTIONS,
    format: (v) => (GUI_SCALE_OPTIONS.find((o) => o.value === v) || GUI_SCALE_OPTIONS[0]).label,
  },
  {
    key: 'particles', label: 'Particles', type: 'select', category: 'video',
    def: 'all', options: PARTICLE_OPTIONS,
    format: (v) => (PARTICLE_OPTIONS.find((o) => o.value === v) || PARTICLE_OPTIONS[0]).label,
  },
  {
    key: 'maxFps', label: 'Max Framerate', type: 'slider', category: 'video',
    def: 0, min: 0, max: 260, step: 10,
    format: (v) => (v <= 0 ? 'Unlimited' : v + ' fps'),
    hint: '0 means uncapped; the browser still limits to the display refresh rate.',
  },
  {
    key: 'smoothLighting', label: 'Smooth Lighting', type: 'toggle', category: 'video',
    def: true, format: onOff,
  },
  {
    key: 'fancyGraphics', label: 'Graphics', type: 'toggle', category: 'video',
    def: true, format: (v) => (v ? 'Fancy' : 'Fast'),
  },
  {
    key: 'clouds', label: 'Clouds', type: 'toggle', category: 'video',
    def: true, format: onOff,
  },
  {
    key: 'entityShadows', label: 'Entity Shadows', type: 'toggle', category: 'video',
    def: true, format: onOff,
  },
  // No mipmap or vsync toggle here on purpose. The texture atlas packs its
  // tiles edge to edge with no padding, so mipmapping would blend neighbouring
  // textures into each other at distance, and requestAnimationFrame is already
  // paced to the display with no way to opt out. A switch that cannot be
  // honoured is worse than no switch; the frame cap below covers the real need.
  {
    key: 'fullscreen', label: 'Fullscreen', type: 'toggle', category: 'video',
    def: false, format: onOff,
  },
  {
    key: 'viewBobbing', label: 'View Bobbing', type: 'toggle', category: 'video',
    def: true, format: onOff,
  },
  {
    key: 'showFps', label: 'Show FPS', type: 'toggle', category: 'video',
    def: false, format: onOff,
  },

  // ---- controls ----------------------------------------------------------
  {
    key: 'mouseSensitivity', label: 'Sensitivity', type: 'slider', category: 'controls',
    def: 0.5, min: 0, max: 2, step: 0.01,
    format: (v) => (v <= 0.001 ? '*yawn*' : v >= 1.999 ? 'HYPERSPEED!!!' : pct(v)),
  },
  {
    key: 'invertY', label: 'Invert Mouse', type: 'toggle', category: 'controls',
    def: false, format: onOff,
  },
  {
    key: 'autoJump', label: 'Auto-Jump', type: 'toggle', category: 'controls',
    def: false, format: onOff,
  },

  // ---- audio -------------------------------------------------------------
  ...SOUND_CATEGORIES.map((cat) => ({
    key: 'volume.' + cat,
    label: VOLUME_LABELS[cat] || cat,
    type: 'slider', category: 'audio',
    def: VOLUME_DEFAULTS[cat] !== undefined ? VOLUME_DEFAULTS[cat] : 1,
    min: 0, max: 1, step: 0.01,
    format: (v) => (v <= 0.001 ? 'Off' : pct(v)),
  })),

  // ---- gameplay ----------------------------------------------------------
  {
    key: 'difficulty', label: 'Difficulty', type: 'select', category: 'gameplay',
    def: DIFFICULTY.NORMAL, options: DIFFICULTY_OPTIONS,
    format: (v) => (DIFFICULTY_OPTIONS.find((o) => o.value === v) || DIFFICULTY_OPTIONS[2]).label,
  },
  {
    key: 'showCoordinates', label: 'Show Coordinates', type: 'toggle', category: 'gameplay',
    def: true, format: onOff,
  },
  {
    key: 'chatOpacity', label: 'Chat Opacity', type: 'slider', category: 'gameplay',
    def: 1, min: 0, max: 1, step: 0.01, format: pct,
  },

  // ---- accessibility -----------------------------------------------------
  {
    key: 'crosshairStyle', label: 'Crosshair', type: 'select', category: 'accessibility',
    def: 'cross', options: CROSSHAIR_OPTIONS,
    format: (v) => (CROSSHAIR_OPTIONS.find((o) => o.value === v) || CROSSHAIR_OPTIONS[0]).label,
  },
  {
    key: 'reducedMotion', label: 'Reduced Motion', type: 'toggle', category: 'accessibility',
    def: false, format: onOff,
    hint: 'Damps screen shake, view bob and camera tilt.',
  },

  // ---- keybinds (controls tab) -------------------------------------------
  ...KEYBIND_ACTIONS.map((action) => ({
    key: 'keybinds.' + action,
    label: KEYBIND_LABELS[action] || action,
    type: 'key', category: 'controls',
    group: KEYBIND_GROUPS[action] || 'gameplay',
    def: DEFAULT_KEYBINDS[action],
    format: keyLabel,
  })),
];

/**
 * Schema driving the options UI. Entries are
 * `{ key, label, type, min, max, step, options, category, format(v) }`
 * where `type` is 'slider' | 'toggle' | 'select' | 'key' and `category` is one
 * of 'video' | 'controls' | 'audio' | 'gameplay' | 'accessibility'.
 */
export const SETTINGS_SCHEMA = OPTION_DEFS.map((d) => Object.freeze({
  key: d.key,
  label: d.label,
  type: d.type,
  category: d.category,
  group: d.group || null,
  min: d.min !== undefined ? d.min : null,
  max: d.max !== undefined ? d.max : null,
  step: d.step !== undefined ? d.step : null,
  options: d.options || null,
  def: d.def,
  hint: d.hint || '',
  format: d.format || ((v) => String(v)),
}));

/** Category ids in display order, with their headings. */
export const SETTINGS_CATEGORIES = Object.freeze([
  { id: 'video', label: 'Video Settings' },
  { id: 'controls', label: 'Controls' },
  { id: 'audio', label: 'Music & Sounds' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'accessibility', label: 'Accessibility' },
]);

const OPTION_MAP = new Map();
for (const entry of SETTINGS_SCHEMA) OPTION_MAP.set(entry.key, entry);

/** Schema entry for a dotted key, or undefined. */
export function schemaFor(key) { return OPTION_MAP.get(key); }

/** All schema entries in one category. */
export function schemaByCategory(category) {
  return SETTINGS_SCHEMA.filter((e) => e.category === category);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function buildDefaults() {
  const out = {
    volume: { ...VOLUME_DEFAULTS },
    keybinds: { ...DEFAULT_KEYBINDS },
  };
  for (const entry of SETTINGS_SCHEMA) {
    if (entry.key.indexOf('.') >= 0) continue;   // nested handled above
    out[entry.key] = entry.def;
  }
  return out;
}

/** A fresh copy of the shipped defaults. Mutating the result is safe. */
export function defaultSettings() { return buildDefaults(); }

/** The default option values (do not mutate; call defaultSettings() for a copy). */
export const DEFAULT_SETTINGS = buildDefaults();

// ---------------------------------------------------------------------------
// Path + coercion helpers
// ---------------------------------------------------------------------------

function readPath(obj, key) {
  if (!obj) return undefined;
  const dot = key.indexOf('.');
  if (dot < 0) return obj[key];
  const head = key.slice(0, dot), rest = key.slice(dot + 1);
  const child = obj[head];
  return child && typeof child === 'object' ? readPath(child, rest) : undefined;
}

function writePath(obj, key, value) {
  const dot = key.indexOf('.');
  if (dot < 0) { obj[key] = value; return; }
  const head = key.slice(0, dot), rest = key.slice(dot + 1);
  if (!obj[head] || typeof obj[head] !== 'object') obj[head] = {};
  writePath(obj[head], rest, value);
}

/** Rounds v to the nearest multiple of `step` measured from `min`. */
function snapStep(v, min, step) {
  if (!step || step <= 0) return v;
  const base = Number.isFinite(min) ? min : 0;
  const n = Math.round((v - base) / step);
  const out = base + n * step;
  // Kill float dust from steps like 0.01.
  const rounded = Math.round(out * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'true' || s === 'on' || s === 'yes' || s === '1') return true;
    if (s === 'false' || s === 'off' || s === 'no' || s === '0') return false;
  }
  return !!fallback;
}

function normalizeKeyCode(v, fallback) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return fallback !== undefined ? fallback : '';
  const s = v.trim();
  if (s === '' || s.toLowerCase() === 'none') return '';
  return s;
}

/** Clamps/normalizes `value` for one schema entry. Falls back to `fallback`. */
function coerceValue(entry, value, fallback) {
  if (!entry) {
    // Unknown key: mirror the type of whatever default we have, else store raw.
    if (typeof fallback === 'boolean') return toBool(value, fallback);
    if (typeof fallback === 'number') {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
    if (typeof fallback === 'string') return value === null || value === undefined ? fallback : String(value);
    return value;
  }
  switch (entry.type) {
    case 'slider': {
      let n = Number(value);
      if (!Number.isFinite(n)) n = Number(entry.def);
      const lo = entry.min !== null ? entry.min : -Infinity;
      const hi = entry.max !== null ? entry.max : Infinity;
      n = clamp(n, lo, hi);
      return snapStep(n, entry.min !== null ? entry.min : 0, entry.step);
    }
    case 'toggle':
      return toBool(value, entry.def);
    case 'select': {
      const opts = entry.options || [];
      // Match on identity first, then on loose/string equality so '2' finds 2.
      for (const o of opts) if (o.value === value) return o.value;
      for (const o of opts) if (String(o.value) === String(value)) return o.value;
      return entry.def;
    }
    case 'key':
      return normalizeKeyCode(value, entry.def);
    default:
      return value;
  }
}

function storage() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch (e) {
    return null;   // Safari private mode / blocked storage
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Holds every user option, validates writes, persists to localStorage and
 * announces changes on the Game event bus as `settingschange(key, value)`.
 */
export class Settings {
  constructor(autoLoad = true) {
    /** @type {Record<string, any>} the live option values */
    this.values = buildDefaults();
    this.storageKey = STORAGE_KEY;
    this.loaded = false;
    this._saveTimer = null;
    if (autoLoad) this.load();
  }

  // ---- reads --------------------------------------------------------------

  /** Reads an option. Supports dotted paths ('volume.music', 'keybinds.jump'). */
  get(key) {
    if (key === undefined || key === null || key === '') return this.values;
    const v = readPath(this.values, String(key));
    return v === undefined ? readPath(DEFAULT_SETTINGS, String(key)) : v;
  }

  /** The shipped default for a key (undefined if the key is unknown). */
  getDefault(key) { return readPath(DEFAULT_SETTINGS, String(key)); }

  /** True when the current value still equals the shipped default. */
  isDefault(key) {
    const cur = this.get(key), def = this.getDefault(key);
    if (cur && typeof cur === 'object') return JSON.stringify(cur) === JSON.stringify(def);
    return cur === def;
  }

  /** Pretty, UI-ready string for a key ('50%', 'Fancy', 'Left Shift'). */
  format(key) {
    const entry = OPTION_MAP.get(String(key));
    const v = this.get(key);
    return entry ? entry.format(v) : String(v);
  }

  // ---- writes -------------------------------------------------------------

  /**
   * Validates and stores an option, persists, and emits
   * `Game.emit('settingschange', key, value)`. Returns the stored value.
   */
  set(key, value) {
    if (typeof key !== 'string' || key === '') return undefined;
    if (key === 'volume') return this._setGroup('volume', value, VOLUME_DEFAULTS);
    if (key === 'keybinds') return this._setGroup('keybinds', value, DEFAULT_KEYBINDS);

    const entry = OPTION_MAP.get(key);
    const v = coerceValue(entry, value, this.getDefault(key));
    const old = readPath(this.values, key);
    if (old === v) return v;
    writePath(this.values, key, v);
    this._afterChange(key, v);
    return v;
  }

  /** Bulk-applies a plain object of options (dotted keys allowed). */
  setAll(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) this.set(k, obj[k]);
  }

  /** Flips a boolean option and returns the new value. */
  toggle(key) {
    const entry = OPTION_MAP.get(String(key));
    if (entry && entry.type !== 'toggle') return this.get(key);
    return this.set(String(key), !this.get(key));
  }

  /** Steps a slider/select option forwards (or backwards with dir = -1). */
  cycle(key, dir = 1) {
    const entry = OPTION_MAP.get(String(key));
    if (!entry) return this.get(key);
    if (entry.type === 'toggle') return this.toggle(key);
    if (entry.type === 'select') {
      const opts = entry.options || [];
      if (!opts.length) return this.get(key);
      let i = opts.findIndex((o) => o.value === this.get(key));
      if (i < 0) i = 0;
      i = ((i + dir) % opts.length + opts.length) % opts.length;
      return this.set(String(key), opts[i].value);
    }
    if (entry.type === 'slider') {
      const step = entry.step || 1;
      return this.set(String(key), this.get(key) + step * dir);
    }
    return this.get(key);
  }

  // ---- volume / keybind conveniences --------------------------------------

  /** Effective 0..1 gain for a sound category, already multiplied by master. */
  getVolume(category) {
    const vol = this.values.volume || VOLUME_DEFAULTS;
    const master = clamp(Number(vol.master ?? 1), 0, 1);
    if (!category || category === 'master') return master;
    const c = clamp(Number(vol[category] ?? 1), 0, 1);
    return master * c;
  }

  /** Sets one sound category's volume (0..1). */
  setVolume(category, v) { return this.set('volume.' + category, v); }

  /** Key code currently bound to an action ('' when unbound). */
  getKeybind(action) {
    const kb = this.values.keybinds;
    const v = kb ? kb[action] : undefined;
    return v === undefined ? (DEFAULT_KEYBINDS[action] || '') : v;
  }

  /**
   * Binds an action to a key code. When `clearConflicts` is set, any other
   * action holding that code is unbound first, the way vanilla does it.
   */
  setKeybind(action, code, clearConflicts = true) {
    if (typeof action !== 'string' || action === '') return '';
    const norm = normalizeKeyCode(code, '');
    if (clearConflicts && norm !== '') {
      for (const other of Object.keys(this.values.keybinds)) {
        if (other !== action && this.values.keybinds[other] === norm) {
          this.values.keybinds[other] = '';
          this._afterChange('keybinds.' + other, '');
        }
      }
    }
    return this.set('keybinds.' + action, norm);
  }

  /** Actions (other than `action`) sharing its key code. */
  conflictsFor(action) {
    const code = this.getKeybind(action);
    if (!code) return [];
    const out = [];
    for (const other of Object.keys(this.values.keybinds)) {
      if (other !== action && this.values.keybinds[other] === code) out.push(other);
    }
    return out;
  }

  /** Restores every keybind to its default. */
  resetKeybinds() {
    this.values.keybinds = { ...DEFAULT_KEYBINDS };
    this._scheduleSave();
    Game.emit('settingschange', 'keybinds', this.values.keybinds);
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Restores every option to its shipped default and persists. */
  reset() {
    const old = this.values;
    this.values = buildDefaults();
    this.save();
    for (const key of Object.keys(this.values)) {
      const a = old ? old[key] : undefined, b = this.values[key];
      const changed = (a && typeof a === 'object') ? JSON.stringify(a) !== JSON.stringify(b) : a !== b;
      if (changed) Game.emit('settingschange', key, b);
    }
    Game.emit('settingschange', '*', this.values);
    return this.values;
  }

  /** Writes the current values to localStorage. Returns true on success. */
  save() {
    if (this._saveTimer !== null) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    const store = storage();
    if (!store) return false;
    try {
      store.setItem(this.storageKey, JSON.stringify(this.values));
      return true;
    } catch (e) {
      console.warn('[settings] could not persist settings:', e && e.message);
      return false;
    }
  }

  /**
   * Reads localStorage over the defaults, dropping anything that fails
   * validation. Safe to call when there is no storage (Node, private mode).
   */
  load() {
    this.values = buildDefaults();
    this.loaded = true;
    const store = storage();
    if (!store) return this.values;
    let raw = null;
    try { raw = store.getItem(this.storageKey); } catch (e) { raw = null; }
    if (!raw) return this.values;
    let data = null;
    try { data = JSON.parse(raw); } catch (e) {
      console.warn('[settings] stored settings were corrupt; using defaults');
      return this.values;
    }
    if (!data || typeof data !== 'object') return this.values;
    this._merge(data);
    return this.values;
  }

  /** Drops the persisted blob without touching the in-memory values. */
  clearStorage() {
    const store = storage();
    if (!store) return false;
    try { store.removeItem(this.storageKey); return true; } catch (e) { return false; }
  }

  /** Plain-object snapshot suitable for JSON. */
  toJSON() { return JSON.parse(JSON.stringify(this.values)); }

  // ---- internals ----------------------------------------------------------

  /** Validates and folds a loaded/imported blob into `values`. */
  _merge(data) {
    for (const key of Object.keys(data)) {
      const incoming = data[key];
      if (key === 'volume' || key === 'keybinds') {
        if (!incoming || typeof incoming !== 'object') continue;
        const target = this.values[key];
        for (const sub of Object.keys(incoming)) {
          const full = key + '.' + sub;
          const entry = OPTION_MAP.get(full);
          const fallback = readPath(DEFAULT_SETTINGS, full);
          if (!entry && fallback === undefined) continue;   // stale/unknown sub-key
          target[sub] = coerceValue(entry, incoming[sub], fallback);
        }
        continue;
      }
      const entry = OPTION_MAP.get(key);
      const fallback = DEFAULT_SETTINGS[key];
      if (!entry && fallback === undefined) continue;       // stale/unknown option
      this.values[key] = coerceValue(entry, incoming, fallback);
    }
  }

  /** Applies a whole `volume`/`keybinds` object, validating each member. */
  _setGroup(groupKey, value, defaults) {
    if (!value || typeof value !== 'object') return this.values[groupKey];
    const target = this.values[groupKey] || (this.values[groupKey] = { ...defaults });
    const changed = [];
    for (const sub of Object.keys(value)) {
      const full = groupKey + '.' + sub;
      const entry = OPTION_MAP.get(full);
      const fallback = readPath(DEFAULT_SETTINGS, full);
      if (!entry && fallback === undefined && defaults[sub] === undefined) continue;
      const v = coerceValue(entry, value[sub], fallback);
      if (target[sub] !== v) { target[sub] = v; changed.push([full, v]); }
    }
    if (!changed.length) return target;
    this._scheduleSave();
    for (const [k, v] of changed) Game.emit('settingschange', k, v);
    Game.emit('settingschange', groupKey, target);
    return target;
  }

  /** Persist + announce one changed key. */
  _afterChange(key, value) {
    // Difficulty lives on Game too so gameplay code has one place to read it.
    if (key === 'difficulty') Game.difficulty = value;
    this._scheduleSave();
    Game.emit('settingschange', key, value);
    const dot = key.indexOf('.');
    if (dot > 0) {
      const root = key.slice(0, dot);
      Game.emit('settingschange', root, this.values[root]);
    }
  }

  /** Coalesces bursts of writes (dragging a slider) into one localStorage hit. */
  _scheduleSave() {
    if (typeof setTimeout !== 'function') { this.save(); return; }
    if (this._saveTimer !== null) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, 250);
  }
}

export default Settings;
