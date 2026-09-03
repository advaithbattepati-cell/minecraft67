// ============================================================================
// input.js - Keyboard, mouse, pointer lock, wheel and touch input.
//
// Everything the game asks about is phrased as an ACTION name ('forward',
// 'jump', 'attack', ...). Actions are resolved through the live keybinds owned
// by core/settings.js, so rebinding a key needs no change anywhere else. A raw
// KeyboardEvent.code also works as an action name, which keeps one-off lookups
// such as isDown('Escape') honest without polluting the keybind table.
//
// Per the game.js header, Game.* is only ever touched inside methods.
// ============================================================================
import { Game } from './game.js';
import { clamp } from './util.js';
import { DEFAULT_KEYBINDS } from './settings.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Milliseconds allowed between two taps of the same action for a double-tap. */
const DOUBLE_TAP_MS = 300;
/** Actions that participate in double-tap gestures (sprint, creative flight). */
const DOUBLE_TAP_ACTIONS = ['forward', 'jump'];
/** Degrees of rotation per pixel of mouse travel at the vanilla default. */
const DEG_PER_PIXEL = 0.15;
const DEG2RAD = Math.PI / 180;
/** Browsers emit one absurd movementX/Y right after lock is granted. */
const MAX_MOUSE_DELTA = 260;
/** Deltas arriving this soon after acquiring lock are discarded. */
const LOCK_SETTLE_MS = 45;
/** Chrome refuses a fresh lock for ~1.25s after Escape; retry after this. */
const LOCK_RETRY_MS = 1400;
/** Touch: max ms + px of travel that still counts as a tap, not a drag. */
const TAP_MS = 220;
const TAP_SLOP = 16;
/** Touch: holding still on the world view this long starts mining. */
const HOLD_MS = 260;
/** Analogue stick geometry, in CSS pixels. */
const STICK_BASE = 132, STICK_KNOB = 58, STICK_RADIUS = 50, STICK_DEADZONE = 0.18;
/** Stick magnitude past which the player is considered to be sprinting. */
const STICK_SPRINT = 0.93;

/** Every action name settings.js knows about; anything else is a raw code. */
const KNOWN_ACTIONS = new Set(Object.keys(DEFAULT_KEYBINDS));

/** Friendly spellings accepted in keybinds, mapped to MouseEvent.button ids. */
const MOUSE_ALIAS = {
  Mouse: 'Mouse0', MouseLeft: 'Mouse0', MouseMiddle: 'Mouse1', MouseRight: 'Mouse2',
  LeftButton: 'Mouse0', MiddleButton: 'Mouse1', RightButton: 'Mouse2',
};

/**
 * Keys whose browser default is always unwanted while the game has focus:
 * page scrolling, focus traversal, Firefox quick-find, browser help.
 */
const PREVENT_ALWAYS = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'F1', 'F2', 'F3',
]);

/**
 * Never stolen from the browser, even under pointer lock: devtools, native
 * fullscreen and screenshots stay reachable. F5 is deliberately absent, since
 * it is bound to the perspective toggle while playing.
 */
const NEVER_PREVENT = new Set(['F11', 'F12', 'PrintScreen']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Canonical form of a stored key code: '' when unbound, chords keep the '+'. */
function normCode(code) {
  if (code === null || code === undefined) return '';
  const s = String(code).trim();
  if (s === '' || s.toLowerCase() === 'none') return '';
  if (s.length > 1 && s.indexOf('+') >= 0) {
    return s.split('+').map((p) => normCode(p)).filter(Boolean).join('+');
  }
  return MOUSE_ALIAS[s] || s;
}

/** 'Mouse2' -> 2, anything else -> -1. */
function mouseIndexOf(code) {
  if (code.length < 6 || code.lastIndexOf('Mouse', 0) !== 0) return -1;
  const n = Number(code.slice(5));
  return Number.isInteger(n) && n >= 0 ? n : -1;
}

/**
 * What kind of DOM element currently owns the keyboard: 'text' for anything
 * that eats characters, 'button' for focusable widgets that react to
 * Space/Enter, null for the game.
 */
function uiFocusKind(el) {
  if (!el || el === document.body || el === document.documentElement) return null;
  if (el.isContentEditable) return 'text';
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'button' || t === 'submit' || t === 'reset' || t === 'checkbox' || t === 'radio')
      ? 'button' : 'text';
  }
  if (tag === 'TEXTAREA') return 'text';
  if (tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || tag === 'OPTION') return 'button';
  if (el.getAttribute && el.getAttribute('role') === 'textbox') return 'text';
  return null;
}

/** Wheel delta in notches, normalised across the three deltaMode units. */
function wheelNotches(e) {
  let d = e.deltaY;
  if (!d && e.deltaX) d = e.deltaX;
  if (!d && e.wheelDelta) d = -e.wheelDelta;
  if (!d) return 0;
  if (e.deltaMode === 1) d *= 16;        // lines
  else if (e.deltaMode === 2) d *= 400;  // pages
  return d / 100;
}

/** Bulk style assignment; the touch pad has to look right without any CSS. */
function css(el, styles) {
  for (const k in styles) el.style[k] = styles[k];
  return el;
}

const TOUCH_IDLE_BG = 'rgba(20,20,24,0.42)';
const TOUCH_ACTIVE_BG = 'rgba(230,230,235,0.55)';

/**
 * On-screen buttons. `right`/`bottom`/`top` are CSS pixels from that edge;
 * `toggle` buttons latch instead of following the finger.
 */
const TOUCH_BUTTONS = [
  { action: 'attack', label: '⛏', title: 'Attack / Mine', right: 18, bottom: 156, size: 62 },
  { action: 'use', label: '✋', title: 'Use / Place', right: 94, bottom: 156, size: 62 },
  { action: 'jump', label: '⬆', title: 'Jump', right: 18, bottom: 80, size: 62 },
  { action: 'sneak', label: '⬇', title: 'Sneak', right: 94, bottom: 80, size: 62, toggle: true },
  { action: 'sprint', label: '»', title: 'Sprint', right: 170, bottom: 80, size: 62, toggle: true },
  { action: 'inventory', label: '▤', title: 'Inventory', right: 18, top: 18, size: 54 },
  { action: 'drop', label: '⬇▫', title: 'Drop', right: 82, top: 18, size: 54 },
];

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Collects raw browser input and exposes it as per-frame action state.
 * One instance is created during boot and parked on `Game.input`.
 */
export class Input {
  /**
   * @param {HTMLCanvasElement|null} canvas the WebGL canvas that takes pointer lock
   * @param {object|null} settings optional Settings instance (defaults to Game.settings)
   */
  constructor(canvas = null, settings = null) {
    /** @type {HTMLCanvasElement|null} */
    this.canvas = canvas || (typeof document !== 'undefined' ? document.getElementById('game-canvas') : null);
    this.settings = settings;

    // ---- public per-frame state (see CONTRACT.md §31) ----
    /** @type {Set<string>} KeyboardEvent.code values currently held. */
    this.keys = new Set();
    /** @type {Set<number>} MouseEvent.button values currently held (0/1/2). */
    this.mouseButtons = new Set();
    /** Raw mouse travel in CSS pixels since the last consume()/getLook(). */
    this.dx = 0;
    this.dy = 0;
    /** Wheel notches since the last consume(); positive = scrolled down. */
    this.wheel = 0;
    /** True while the canvas owns the pointer. */
    this.pointerLocked = false;
    /** True once touch controls exist on screen. */
    this.touch = false;
    /** Last known cursor position in client pixels (only meaningful unlocked). */
    this.mouseX = 0;
    this.mouseY = 0;

    // ---- behaviour flags ----
    /** Master switch; when false every event is ignored. */
    this.enabled = true;
    /** Clicking the bare canvas grabs the pointer. */
    this.autoLock = true;
    /** First genuine touch spawns the on-screen controls. */
    this.autoTouch = true;
    /** Extra multiplier applied to touch look drags. */
    this.touchLookScale = 1.45;
    /** Settable callback(locked) so main.js can auto-pause. */
    this.onLockChange = null;
    /** True while a double-tap-forward sprint is latched. */
    this.sprintLatch = false;
    /** Frame counter, handy for debugging stuck keys. */
    this.frame = 0;

    // ---- private state ----
    this._justPressed = new Set();    // codes pressed during this frame
    this._justReleased = new Set();   // codes released during this frame
    this._pressedActions = new Set(); // virtual (touch) presses this frame
    this._releasedActions = new Set();
    this._touchActions = new Set();   // actions held by an on-screen button
    this._pulse = new Set();          // actions "down" for exactly one frame
    this._wheelCodes = new Set();     // 'WheelUp'/'WheelDown' for this frame
    this._doubleTapped = new Set();
    this._lastTap = new Map();
    this._localBinds = new Map();     // overrides used when there is no Settings
    this._wheelAccum = 0;
    this._wantLock = false;
    this._lockTime = 0;
    this._lockRetry = 0;
    this._lockErrorAt = 0;
    this._disposed = false;

    // Touch runtime state.
    this._touchRoot = null;
    this._touchButtons = new Map();
    this._stick = { active: false, id: null, baseX: 0, baseY: 0, mag: 0, forward: 0, strafe: 0 };
    this._look = { id: null, x: 0, y: 0, moved: 0, start: 0, held: false, timer: 0 };

    this._bind();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Attaches every DOM listener. Called once from the constructor. */
  _bind() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const c = this.canvas;

    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp = (e) => this._handleKeyUp(e);
    this._onMouseDown = (e) => this._handleMouseDown(e);
    this._onMouseUp = (e) => this._handleMouseUp(e);
    this._onMouseMove = (e) => this._handleMouseMove(e);
    this._onWheel = (e) => this._handleWheel(e);
    this._onContextMenu = (e) => { if (this.enabled) e.preventDefault(); };
    this._onBlur = () => this.releaseAll();
    this._onVisibility = () => { if (document.hidden) this.releaseAll(); };
    this._onFocusIn = (e) => { if (uiFocusKind(e.target) === 'text') this.releaseAll(); };
    this._onLockChangeEvt = () => this._syncLockState();
    this._onLockError = () => this._handleLockError();
    this._onFirstTouch = (e) => {
      if (!this.autoTouch || this._touchRoot) return;
      if (e.pointerType && e.pointerType !== 'touch') return;
      this.enableTouchControls();
    };

    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup', this._onKeyUp, { capture: true });
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('pointerdown', this._onFirstTouch, { passive: true });
    document.addEventListener('visibilitychange', this._onVisibility);
    document.addEventListener('focusin', this._onFocusIn);
    document.addEventListener('pointerlockchange', this._onLockChangeEvt);
    document.addEventListener('pointerlockerror', this._onLockError);
    // Older WebKit spellings; harmless when unsupported.
    document.addEventListener('webkitpointerlockchange', this._onLockChangeEvt);
    document.addEventListener('webkitpointerlockerror', this._onLockError);

    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    (c || window).addEventListener('contextmenu', this._onContextMenu);
    if (c) this._bindTouchLook(c);
  }

  /** Removes every listener and any on-screen control. */
  dispose() {
    if (this._disposed || typeof window === 'undefined') return;
    this._disposed = true;
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    window.removeEventListener('keyup', this._onKeyUp, { capture: true });
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('pointerdown', this._onFirstTouch);
    document.removeEventListener('visibilitychange', this._onVisibility);
    document.removeEventListener('focusin', this._onFocusIn);
    document.removeEventListener('pointerlockchange', this._onLockChangeEvt);
    document.removeEventListener('pointerlockerror', this._onLockError);
    document.removeEventListener('webkitpointerlockchange', this._onLockChangeEvt);
    document.removeEventListener('webkitpointerlockerror', this._onLockError);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('wheel', this._onWheel);
    (this.canvas || window).removeEventListener('contextmenu', this._onContextMenu);
    if (this.canvas && this._onTouchLookDown) {
      this.canvas.removeEventListener('pointerdown', this._onTouchLookDown);
      this.canvas.removeEventListener('pointermove', this._onTouchLookMove);
      this.canvas.removeEventListener('pointerup', this._onTouchLookUp);
      this.canvas.removeEventListener('pointercancel', this._onTouchLookUp);
    }
    this.disableTouchControls(true);
    this.releaseAll();
  }

  // -------------------------------------------------------------------------
  // Keybind resolution
  // -------------------------------------------------------------------------

  /** The live Settings instance, or null before boot finishes. */
  _settings() {
    return this.settings || Game.settings || null;
  }

  /**
   * Key code bound to an action. Unknown names fall through as raw codes so
   * `isDown('KeyG')` and `isDown('Escape')` work without a binding.
   */
  keyFor(action) {
    if (typeof action !== 'string' || action === '') return '';
    if (this._localBinds.has(action)) return this._localBinds.get(action);
    if (!KNOWN_ACTIONS.has(action)) return normCode(action);
    const s = this._settings();
    if (s && typeof s.getKeybind === 'function') {
      const v = s.getKeybind(action);
      if (typeof v === 'string') return normCode(v);
    }
    return normCode(DEFAULT_KEYBINDS[action] || '');
  }

  /**
   * Rebinds an action. Writes through to Settings when one exists (so the
   * change persists and conflicting binds are cleared), otherwise keeps a
   * local override. Returns the stored code.
   */
  bindAction(action, code) {
    if (typeof action !== 'string' || action === '') return '';
    const norm = normCode(code);
    const s = this._settings();
    if (s && typeof s.setKeybind === 'function' && KNOWN_ACTIONS.has(action)) {
      this._localBinds.delete(action);
      const stored = s.setKeybind(action, norm);
      return typeof stored === 'string' ? stored : norm;
    }
    this._localBinds.set(action, norm);
    return norm;
  }

  /** Every action currently bound to a code (usually zero or one). */
  actionsFor(code) {
    const want = normCode(code);
    const out = [];
    if (!want) return out;
    for (const action of KNOWN_ACTIONS) if (this.keyFor(action) === want) out.push(action);
    for (const [action, bound] of this._localBinds) {
      if (bound === want && out.indexOf(action) < 0) out.push(action);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // State queries
  // -------------------------------------------------------------------------

  /** True while a single (non-chord) code is held. */
  _codeDown(code) {
    if (!code) return false;
    const m = mouseIndexOf(code);
    if (m >= 0) return this.mouseButtons.has(m);
    if (code === 'WheelUp' || code === 'WheelDown') return this._wheelCodes.has(code);
    return this.keys.has(code);
  }

  /** Chord-aware "held" test. */
  _bindDown(code) {
    if (!code) return false;
    if (code.indexOf('+') < 0) return this._codeDown(code);
    const parts = code.split('+');
    for (let i = 0; i < parts.length; i++) if (!this._codeDown(parts[i])) return false;
    return true;
  }

  /** Chord-aware "went down this frame" test: last key completes the chord. */
  _bindPressed(code) {
    if (!code) return false;
    if (code.indexOf('+') < 0) return this._justPressed.has(code);
    const parts = code.split('+');
    const last = parts[parts.length - 1];
    if (!this._justPressed.has(last)) return false;
    for (let i = 0; i < parts.length - 1; i++) if (!this._codeDown(parts[i])) return false;
    return true;
  }

  /** Chord-aware "came up this frame" test: any member released breaks it. */
  _bindReleased(code) {
    if (!code) return false;
    if (code.indexOf('+') < 0) return this._justReleased.has(code);
    const parts = code.split('+');
    for (let i = 0; i < parts.length; i++) if (this._justReleased.has(parts[i])) return true;
    return false;
  }

  /** True while the action is held, by key, mouse button or touch button. */
  isDown(action) {
    if (!action || !this.enabled) return false;
    if (this._touchActions.has(action) || this._pulse.has(action)) return true;
    if (action === 'sprint' && this.isSprintLatched()) return true;
    return this._bindDown(this.keyFor(action));
  }

  /** True on the single frame the action went down. */
  justPressed(action) {
    if (!action || !this.enabled) return false;
    if (this._pressedActions.has(action)) return true;
    return this._bindPressed(this.keyFor(action));
  }

  /** True on the single frame the action came up. */
  justReleased(action) {
    if (!action || !this.enabled) return false;
    if (this._releasedActions.has(action)) return true;
    return this._bindReleased(this.keyFor(action));
  }

  /** True on the frame a second quick tap of `action` landed. */
  justDoubleTapped(action) {
    return this._doubleTapped.has(action);
  }

  /** True while anything at all is held or was tapped this frame. */
  anyKeyPressed() {
    return this.keys.size > 0 || this.mouseButtons.size > 0 ||
      this._touchActions.size > 0 || this._justPressed.size > 0 ||
      this._pressedActions.size > 0;
  }

  /** Raw code test, bypassing keybinds ('ShiftLeft', 'Mouse0', ...). */
  isKeyDown(code) { return this._bindDown(normCode(code)); }

  /** True while any Shift / Control / Alt key is held. */
  get shift() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }
  get ctrl() { return this.keys.has('ControlLeft') || this.keys.has('ControlRight'); }
  get alt() { return this.keys.has('AltLeft') || this.keys.has('AltRight'); }

  /**
   * Hotbar slot selected this frame by a number key, or -1.
   * @returns {number} 0..8
   */
  hotbarPressed() {
    for (let i = 0; i < 9; i++) if (this.justPressed('hotbar' + (i + 1))) return i;
    return -1;
  }

  // -------------------------------------------------------------------------
  // Movement / look
  // -------------------------------------------------------------------------

  /**
   * Desired movement this frame, keyboard and touch stick combined.
   * @returns {{forward:number, strafe:number}} each in [-1, 1]
   */
  getMovement() {
    let forward = 0, strafe = 0;
    if (this.enabled) {
      if (this.isDown('forward')) forward += 1;
      if (this.isDown('back')) forward -= 1;
      if (this.isDown('right')) strafe += 1;
      if (this.isDown('left')) strafe -= 1;
      if (this._stick.active) { forward += this._stick.forward; strafe += this._stick.strafe; }
    }
    return { forward: clamp(forward, -1, 1), strafe: clamp(strafe, -1, 1) };
  }

  /** Radians of rotation per pixel, following vanilla's cubic sensitivity curve. */
  lookScale() {
    const s = this._settings();
    let sens = 0.5;
    if (s && typeof s.get === 'function') {
      const v = Number(s.get('mouseSensitivity'));
      if (Number.isFinite(v)) sens = v;
    }
    const f = clamp(sens, 0, 2) * 0.6 + 0.2;
    return f * f * f * 8 * DEG_PER_PIXEL * DEG2RAD;
  }

  /**
   * Look delta for this frame in radians, already scaled by sensitivity and
   * flipped when "Invert Mouse" is on. Consumes the accumulated deltas, so it
   * must be called at most once per frame per camera.
   * @returns {{dx:number, dy:number}} dx = yaw, dy = pitch
   */
  getLook() {
    const scale = this.lookScale();
    const s = this._settings();
    const invert = !!(s && typeof s.get === 'function' && s.get('invertY'));
    const out = { dx: this.dx * scale, dy: this.dy * scale * (invert ? -1 : 1) };
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  /** True while sprint should be active: bound key, double-tap or full stick. */
  isSprintLatched() {
    if (this.sprintLatch) return true;
    return this._stick.active && this._stick.mag > STICK_SPRINT;
  }

  /** Drops the double-tap sprint latch (hunger too low, wall hit, ...). */
  clearSprintLatch() { this.sprintLatch = false; }

  // -------------------------------------------------------------------------
  // Frame lifecycle
  // -------------------------------------------------------------------------

  /**
   * Clears per-frame deltas and edge sets. Call once at the very end of the
   * frame, after every consumer has read the input.
   */
  consume() {
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this._justPressed.clear();
    this._justReleased.clear();
    this._pressedActions.clear();
    this._releasedActions.clear();
    this._doubleTapped.clear();
    this._wheelCodes.clear();
    this._pulse.clear();
    this.frame++;
  }

  /** Forgets every held key/button; used on blur and when a screen opens. */
  releaseAll() {
    for (const code of this.keys) this._justReleased.add(code);
    this.keys.clear();
    for (const b of this.mouseButtons) this._justReleased.add('Mouse' + b);
    this.mouseButtons.clear();
    for (const a of this._touchActions) this._releasedActions.add(a);
    this._touchActions.clear();
    for (const [, btn] of this._touchButtons) btn.style.background = TOUCH_IDLE_BG;
    this._resetStick();
    this._endLookTouch(true);
    this.sprintLatch = false;
    this._wheelAccum = 0;
    this._lastTap.clear();
    this.dx = 0;
    this.dy = 0;
  }

  /** Turns the whole input layer on or off (menus, cutscenes, tests). */
  setEnabled(on) {
    const v = !!on;
    if (v === this.enabled) return;
    this.enabled = v;
    if (!v) this.releaseAll();
  }

  // -------------------------------------------------------------------------
  // Pointer lock
  // -------------------------------------------------------------------------

  /** Asks the browser for the pointer. Must run inside a user gesture. */
  requestPointerLock() {
    const c = this.canvas;
    if (!c || typeof c.requestPointerLock !== 'function') return false;
    this._wantLock = true;
    if (this.pointerLocked) return true;
    try {
      // unadjustedMovement gives raw deltas; unsupported browsers reject or ignore it.
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (!this._wantLock || this.pointerLocked) return;
          try { c.requestPointerLock(); } catch (e) { /* handled by pointerlockerror */ }
        });
      }
    } catch (e) {
      try { c.requestPointerLock(); } catch (e2) { return false; }
    }
    return true;
  }

  /** Releases the pointer (also what Escape does natively). */
  exitPointerLock() {
    this._wantLock = false;
    if (this._lockRetry) { clearTimeout(this._lockRetry); this._lockRetry = 0; }
    try { if (document.exitPointerLock) document.exitPointerLock(); } catch (e) { /* ignore */ }
  }

  /** True when a lock request would probably succeed right now. */
  canLock() {
    if (!this.canvas) return false;
    if (!this._lockErrorAt) return true;               // nothing has been refused yet
    return (performance.now() - this._lockErrorAt) > LOCK_RETRY_MS;
  }

  _syncLockState() {
    const el = document.pointerLockElement || document.webkitPointerLockElement || null;
    const locked = !!el && (!this.canvas || el === this.canvas);
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    if (locked) {
      this._lockTime = performance.now();
      this._lockErrorAt = 0;
    } else {
      this._wantLock = false;
      for (const b of this.mouseButtons) this._justReleased.add('Mouse' + b);
      this.mouseButtons.clear();
      this.dx = 0;
      this.dy = 0;
    }
    if (typeof this.onLockChange === 'function') {
      try { this.onLockChange(locked); } catch (e) { console.error('[input] onLockChange', e); }
    }
  }

  _handleLockError() {
    this._lockErrorAt = performance.now();
    this.pointerLocked = false;
    // Chrome blocks re-locking briefly after Escape; try again once.
    if (this._wantLock && !this._lockRetry) {
      this._lockRetry = setTimeout(() => {
        this._lockRetry = 0;
        if (this._wantLock && !this.pointerLocked && this.canvas) {
          try { this.canvas.requestPointerLock(); } catch (e) { /* give up quietly */ }
        }
      }, LOCK_RETRY_MS);
    }
    if (typeof this.onLockChange === 'function') {
      try { this.onLockChange(false); } catch (e) { console.error('[input] onLockChange', e); }
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  _handleKeyDown(e) {
    if (!this.enabled || this._disposed) return;
    const focus = uiFocusKind(e.target) || uiFocusKind(document.activeElement);
    if (focus === 'text') return;                       // chat/name fields keep their keys
    if (focus === 'button' && (e.code === 'Space' || e.code === 'Enter')) return;

    if (this._shouldPrevent(e)) e.preventDefault();
    if (e.repeat) return;                               // auto-repeat is not a new press

    const code = e.code || e.key;
    if (!code) return;
    if (this.keys.has(code)) return;
    this.keys.add(code);
    this._pressCode(code);

    // Escape always drops the pointer so the pause menu can take over. Some
    // browsers swallow the keydown and only fire pointerlockchange, which the
    // lock handler covers as well.
    if (code === 'Escape' && this.pointerLocked) this.exitPointerLock();
  }

  _handleKeyUp(e) {
    if (this._disposed) return;
    const code = e.code || e.key;
    if (!code) return;
    if (!this.keys.delete(code)) return;
    this._justReleased.add(code);
    if (this.sprintLatch && code === this.keyFor('forward')) this.sprintLatch = false;
  }

  /** Decides whether the browser's default for this key is unwanted. */
  _shouldPrevent(e) {
    if (!this.enabled) return false;
    if (NEVER_PREVENT.has(e.code)) return false;
    if (e.metaKey) return false;                       // leave OS shortcuts alone
    if (PREVENT_ALWAYS.has(e.code) && !e.ctrlKey) return true;
    if (!this.pointerLocked) return false;             // menus behave like a web page
    if (e.ctrlKey && (e.code === 'KeyR' || e.code === 'KeyT' || e.code === 'KeyW' ||
      e.code === 'KeyN' || e.code === 'KeyL')) return false;
    return true;
  }

  /** Shared bookkeeping for any code that just went down. */
  _pressCode(code) {
    this._justPressed.add(code);
    for (let i = 0; i < DOUBLE_TAP_ACTIONS.length; i++) {
      const action = DOUBLE_TAP_ACTIONS[i];
      if (this.keyFor(action) === code) this._noteTap(action);
    }
  }

  /** Records a tap of an action and latches sprint on a double-tap forward. */
  _noteTap(action) {
    if (DOUBLE_TAP_ACTIONS.indexOf(action) < 0) return false;
    const now = performance.now();
    const last = this._lastTap.get(action);
    this._lastTap.set(action, now);
    if (last === undefined || now - last > DOUBLE_TAP_MS) return false;
    this._doubleTapped.add(action);
    this._lastTap.delete(action);           // three taps must not chain
    if (action === 'forward') {
      this.sprintLatch = true;
      this._pressedActions.add('sprint');
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Mouse
  // -------------------------------------------------------------------------

  _handleMouseDown(e) {
    if (!this.enabled || this._disposed) return;
    const onCanvas = !this.canvas || e.target === this.canvas ||
      e.target === document.body || (e.target && e.target.id === 'app');
    if (!onCanvas) return;
    if (e.button === 1 || (this.pointerLocked && e.button === 2)) e.preventDefault();

    if (!this.pointerLocked && this.autoLock && !this.touch && e.button === 0 && this.canLock()) {
      // Clicking the bare 3D view grabs the pointer, exactly like vanilla.
      this.requestPointerLock();
    }
    if (this.mouseButtons.has(e.button)) return;
    this.mouseButtons.add(e.button);
    this._pressCode('Mouse' + e.button);
  }

  _handleMouseUp(e) {
    if (this._disposed) return;
    if (!this.mouseButtons.delete(e.button)) return;
    this._justReleased.add('Mouse' + e.button);
  }

  _handleMouseMove(e) {
    if (this._disposed) return;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    if (!this.enabled || !this.pointerLocked) return;
    // The first event after a lock is often a huge synthetic jump.
    if (performance.now() - this._lockTime < LOCK_SETTLE_MS) return;
    let mx = e.movementX, my = e.movementY;
    if (mx === undefined) mx = 0;
    if (my === undefined) my = 0;
    if (mx > MAX_MOUSE_DELTA || mx < -MAX_MOUSE_DELTA) return;
    if (my > MAX_MOUSE_DELTA || my < -MAX_MOUSE_DELTA) return;
    this.dx += mx;
    this.dy += my;
  }

  /**
   * True when a wheel event should drive the hotbar instead of scrolling a
   * piece of UI. Under pointer lock everything belongs to the game.
   */
  _wheelBelongsToGame(target) {
    if (this.pointerLocked) return true;
    if (uiFocusKind(target) === 'text') return false;
    let el = target;
    for (let i = 0; i < 8 && el && el.nodeType === 1; i++) {
      if (el === this.canvas) return true;
      if (el.scrollHeight - el.clientHeight > 2) {
        let ov = '';
        try { ov = getComputedStyle(el).overflowY; } catch (err) { ov = ''; }
        if (ov === 'auto' || ov === 'scroll') return false;
      }
      el = el.parentElement;
    }
    return true;
  }

  _handleWheel(e) {
    if (!this.enabled || this._disposed) return;
    if (!this._wheelBelongsToGame(e.target)) return;   // let scrollable UI scroll
    if (e.cancelable) e.preventDefault();
    const d = wheelNotches(e);
    if (!d) return;
    // Reversing direction must respond immediately, not spend the old residue.
    if ((d > 0) !== (this._wheelAccum > 0)) this._wheelAccum = 0;
    this._wheelAccum += d;
    // Emit whole notches so trackpads do not spam the hotbar.
    while (this._wheelAccum >= 1) {
      this._wheelAccum -= 1;
      this.wheel += 1;
      this._wheelCodes.add('WheelDown');
      this._justPressed.add('WheelDown');
    }
    while (this._wheelAccum <= -1) {
      this._wheelAccum += 1;
      this.wheel -= 1;
      this._wheelCodes.add('WheelUp');
      this._justPressed.add('WheelUp');
    }
  }

  // -------------------------------------------------------------------------
  // Virtual (touch) actions
  // -------------------------------------------------------------------------

  /** Holds or releases an action from an on-screen control. */
  _setTouchAction(action, on) {
    if (on) {
      if (this._touchActions.has(action)) return;
      this._touchActions.add(action);
      this._pressedActions.add(action);
      this._noteTap(action);
    } else {
      if (!this._touchActions.delete(action)) return;
      this._releasedActions.add(action);
      if (action === 'forward') this.sprintLatch = false;
    }
  }

  /** Fires an action for exactly one frame (a tap on the world view). */
  _pulseAction(action) {
    this._pulse.add(action);
    this._pressedActions.add(action);
    this._releasedActions.add(action);
  }

  // -------------------------------------------------------------------------
  // Touch controls
  // -------------------------------------------------------------------------

  /** Camera drag + tap-to-mine on the 3D view itself, touch pointers only. */
  _bindTouchLook(el) {
    this._onTouchLookDown = (e) => {
      if (!this.enabled || e.pointerType !== 'touch') return;
      if (this._look.id !== null) return;               // one finger looks, the rest act
      this._look.id = e.pointerId;
      this._look.x = e.clientX;
      this._look.y = e.clientY;
      this._look.moved = 0;
      this._look.start = performance.now();
      this._look.held = false;
      if (this._look.timer) clearTimeout(this._look.timer);
      this._look.timer = setTimeout(() => {
        this._look.timer = 0;
        if (this._look.id === null || this._look.moved > TAP_SLOP) return;
        this._look.held = true;
        this._setTouchAction('attack', true);           // press-and-hold mines
      }, HOLD_MS);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      e.preventDefault();
    };
    this._onTouchLookMove = (e) => {
      if (e.pointerType !== 'touch' || e.pointerId !== this._look.id) return;
      const mx = e.clientX - this._look.x;
      const my = e.clientY - this._look.y;
      this._look.x = e.clientX;
      this._look.y = e.clientY;
      this._look.moved += Math.abs(mx) + Math.abs(my);
      this.dx += mx * this.touchLookScale;
      this.dy += my * this.touchLookScale;
      e.preventDefault();
    };
    this._onTouchLookUp = (e) => {
      if (e.pointerType !== 'touch' || e.pointerId !== this._look.id) return;
      const tapped = !this._look.held &&
        performance.now() - this._look.start < TAP_MS && this._look.moved < TAP_SLOP;
      this._endLookTouch(false);
      if (tapped) this._pulseAction('attack');          // quick tap = one hit
      try { el.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    };
    el.addEventListener('pointerdown', this._onTouchLookDown);
    el.addEventListener('pointermove', this._onTouchLookMove);
    el.addEventListener('pointerup', this._onTouchLookUp);
    el.addEventListener('pointercancel', this._onTouchLookUp);
  }

  _endLookTouch(silent) {
    if (this._look.timer) { clearTimeout(this._look.timer); this._look.timer = 0; }
    if (this._look.held) this._setTouchAction('attack', false);
    this._look.held = false;
    this._look.id = null;
    if (silent) this._look.moved = 0;
  }

  /**
   * Builds the on-screen pad the first time it is needed: a floating left
   * stick, jump/sneak/sprint/attack/use/inventory/drop buttons, and camera
   * drag handled directly on the canvas.
   * @param {HTMLElement|null} root where to mount (defaults to #ui-root)
   * @returns {HTMLElement|null} the container
   */
  enableTouchControls(root = null) {
    if (typeof document === 'undefined') return null;
    if (this._touchRoot) {
      this._touchRoot.style.display = '';
      this.touch = true;
      return this._touchRoot;
    }
    const host = root || document.getElementById('ui-root') || document.body;
    if (!host) return null;

    const wrap = css(document.createElement('div'), {
      position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
      zIndex: '45', pointerEvents: 'none', touchAction: 'none',
      userSelect: 'none', webkitUserSelect: 'none',
      webkitTapHighlightColor: 'transparent',
    });
    wrap.className = 'touch-controls';

    wrap.appendChild(this._buildStick());
    for (let i = 0; i < TOUCH_BUTTONS.length; i++) wrap.appendChild(this._buildButton(TOUCH_BUTTONS[i]));

    host.appendChild(wrap);
    if (this.canvas) this.canvas.style.touchAction = 'none';
    this._touchRoot = wrap;
    this.touch = true;
    this.autoLock = false;                              // no pointer lock on a phone
    window.removeEventListener('pointerdown', this._onFirstTouch);
    return wrap;
  }

  /** Hides the touch pad; pass true to destroy it outright. */
  disableTouchControls(destroy = false) {
    if (!this._touchRoot) return;
    for (const a of this._touchActions) this._releasedActions.add(a);
    this._touchActions.clear();
    for (const [, btn] of this._touchButtons) btn.style.background = TOUCH_IDLE_BG;
    this._resetStick();
    if (destroy) {
      if (this._touchRoot.parentNode) this._touchRoot.parentNode.removeChild(this._touchRoot);
      this._touchRoot = null;
      this._touchButtons.clear();
      if (this.canvas) this.canvas.style.touchAction = '';
    } else {
      this._touchRoot.style.display = 'none';
    }
    this.touch = false;
  }

  /** The floating analogue stick in the bottom-left corner. */
  _buildStick() {
    const zone = css(document.createElement('div'), {
      position: 'absolute', left: '0', bottom: '0', width: '46%', height: '52%',
      minWidth: '150px', pointerEvents: 'auto', touchAction: 'none',
    });
    zone.className = 'touch-stick-zone';

    const base = css(document.createElement('div'), {
      position: 'absolute', left: '30px', bottom: '30px',
      width: STICK_BASE + 'px', height: STICK_BASE + 'px', borderRadius: '50%',
      border: '2px solid rgba(255,255,255,0.35)', background: 'rgba(20,20,24,0.28)',
      boxSizing: 'border-box', pointerEvents: 'none',
    });
    base.className = 'touch-stick-base';

    const knob = css(document.createElement('div'), {
      position: 'absolute', left: '50%', top: '50%',
      width: STICK_KNOB + 'px', height: STICK_KNOB + 'px', borderRadius: '50%',
      background: 'rgba(235,235,240,0.5)', border: '2px solid rgba(255,255,255,0.55)',
      boxSizing: 'border-box', transform: 'translate(-50%,-50%)', pointerEvents: 'none',
    });
    knob.className = 'touch-stick-knob';
    base.appendChild(knob);
    zone.appendChild(base);

    const home = () => {
      css(base, { left: '30px', top: 'auto', bottom: '30px' });
      knob.style.transform = 'translate(-50%,-50%)';
    };

    const down = (e) => {
      if (this._stick.id !== null) return;
      const r = zone.getBoundingClientRect();
      const half = STICK_BASE / 2;
      const bx = clamp(e.clientX - r.left, half + 4, Math.max(half + 4, r.width - half - 4));
      const by = clamp(e.clientY - r.top, half + 4, Math.max(half + 4, r.height - half - 4));
      css(base, { left: (bx - half) + 'px', top: (by - half) + 'px', bottom: 'auto' });
      this._stick.id = e.pointerId;
      this._stick.active = true;
      this._stick.baseX = r.left + bx;
      this._stick.baseY = r.top + by;
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      move(e);
      e.preventDefault();
      e.stopPropagation();
    };

    const move = (e) => {
      if (e.pointerId !== this._stick.id) return;
      let vx = e.clientX - this._stick.baseX;
      let vy = e.clientY - this._stick.baseY;
      const len = Math.sqrt(vx * vx + vy * vy) || 1;
      const mag = Math.min(1, len / STICK_RADIUS);
      vx = (vx / len) * mag;
      vy = (vy / len) * mag;
      knob.style.transform = 'translate(-50%,-50%) translate(' +
        (vx * STICK_RADIUS) + 'px,' + (vy * STICK_RADIUS) + 'px)';
      const scaled = mag <= STICK_DEADZONE ? 0 : (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE);
      this._stick.mag = scaled;
      this._stick.strafe = scaled ? (vx / mag) * scaled : 0;
      this._stick.forward = scaled ? -(vy / mag) * scaled : 0;
      if (e.cancelable) e.preventDefault();
    };

    const up = (e) => {
      if (e.pointerId !== this._stick.id) return;
      this._resetStick();
      home();
      try { zone.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    };

    zone.addEventListener('pointerdown', down);
    zone.addEventListener('pointermove', move);
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
    this._stickHome = home;
    return zone;
  }

  _resetStick() {
    this._stick.active = false;
    this._stick.id = null;
    this._stick.mag = 0;
    this._stick.forward = 0;
    this._stick.strafe = 0;
    if (this._stickHome) this._stickHome();
  }

  /** One on-screen button. Toggle buttons latch until tapped again. */
  _buildButton(cfg) {
    const size = cfg.size || 62;
    const el = css(document.createElement('div'), {
      position: 'absolute', width: size + 'px', height: size + 'px',
      right: cfg.right + 'px',
      borderRadius: '10px', border: '2px solid rgba(255,255,255,0.35)',
      background: TOUCH_IDLE_BG, color: '#fff',
      font: '600 ' + Math.round(size * 0.42) + 'px/1 system-ui, sans-serif',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'auto', touchAction: 'none', boxSizing: 'border-box',
      textShadow: '0 1px 2px rgba(0,0,0,0.8)',
    });
    if (cfg.top !== undefined) el.style.top = cfg.top + 'px';
    else el.style.bottom = cfg.bottom + 'px';
    el.className = 'touch-btn touch-btn-' + cfg.action;
    el.textContent = cfg.label;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', cfg.title || cfg.action);

    const paint = (on) => { el.style.background = on ? TOUCH_ACTIVE_BG : TOUCH_IDLE_BG; };

    const press = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      if (cfg.toggle) {
        const on = !this._touchActions.has(cfg.action);
        this._setTouchAction(cfg.action, on);
        paint(on);
      } else {
        this._setTouchAction(cfg.action, true);
        paint(true);
      }
    };
    const release = (e) => {
      if (e) e.stopPropagation();
      if (cfg.toggle) return;
      this._setTouchAction(cfg.action, false);
      paint(false);
    };

    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this._touchButtons.set(cfg.action, el);
    return el;
  }
}

export default Input;
