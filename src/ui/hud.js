// ============================================================================
// hud.js - The in-world heads-up display. (CONTRACT.md section 28)
//
// Design rules this file sticks to:
//
//  1. The whole DOM tree is built exactly once, in the constructor. `update()`
//     never calls innerHTML and never creates nodes for anything that changes
//     every frame - it only writes text, CSS custom properties and class names,
//     and only when the value actually moved. Every mutating helper compares
//     against a cached "last written" value first, so a steady-state frame does
//     essentially zero DOM work.
//  2. Anything that changes rarely (the hotbar contents, the status effect
//     list, the boss bars) is rebuilt from a Game event or from a cheap version
//     counter, not polled per frame.
//  3. Every read of another module goes through a try/catch or optional
//     chaining. A half-finished neighbour must degrade one widget, never blank
//     the screen.
//
// Layering: the full-screen tints in style.css carry z-index 2/3, so all the
// real widgets live in a wrapper above them at z-index 5. That reproduces
// vanilla's order (hurt/underwater tint behind the hotbar, not over it).
// ============================================================================
import { Game } from '../core/game.js';
import {
  MAX_HEALTH, MAX_HUNGER, MAX_AIR, HOTBAR_SIZE, GAMEMODE, TICKS_PER_SECOND,
} from '../core/constants.js';
import { clamp, roman, prettyName } from '../core/util.js';
import { stackElement, drawStack } from '../render/itemrender.js';
import { stackDisplayName, stackRarity } from '../item/inventory.js';
import { activeEffects, formatEffectTime, effectDisplayName } from '../item/effects.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Number of icons in each status row: 10 hearts = 20 half units. */
const ROW = 10;
/** How long the held-item name stays solid before it starts fading (seconds). */
const ITEM_NAME_HOLD = 2.0;
/** Matches the 0.5s opacity transition on .hotbar-item-name. */
const ITEM_NAME_FADE = 0.5;
/** Action bar hold / fade, matching the 0.4s transition on .action-bar. */
const ACTION_HOLD = 3.0;
const ACTION_FADE = 0.4;
/** Ticks a nether portal needs before the screen is fully purple. */
const PORTAL_TICKS = 80;
/** Powder-snow freeze ticks to reach a fully frozen player. */
const FREEZE_TICKS = 140;
/** How often the boss-bar scan and the effect timers refresh (seconds). */
const SLOW_POLL = 0.25;
/** An effect icon starts blinking with this many ticks left (vanilla: 10s). */
const EXPIRING_TICKS = 10 * TICKS_PER_SECOND;

/** Three-letter glyphs for the effect icons; unknown effects fall back to initials. */
const EFFECT_GLYPH = {
  speed: 'SPD', slowness: 'SLW', haste: 'HST', mining_fatigue: 'FTG',
  strength: 'STR', instant_health: 'HP+', instant_damage: 'HP-',
  jump_boost: 'JMP', nausea: 'NSA', regeneration: 'REG', resistance: 'RES',
  fire_resistance: 'FIR', water_breathing: 'H2O', invisibility: 'INV',
  blindness: 'BLD', night_vision: 'NVS', hunger: 'HGR', weakness: 'WEK',
  poison: 'PSN', wither: 'WTH', health_boost: 'HP', absorption: 'ABS',
  saturation: 'SAT', glowing: 'GLW', levitation: 'LEV', luck: 'LCK',
  unluck: 'ULK', slow_falling: 'SLF', conduit_power: 'CDT',
  dolphins_grace: 'DLP', bad_omen: 'OMN', hero_of_the_village: 'HRO',
  darkness: 'DRK', infested: 'IFS', oozing: 'OOZ', weaving: 'WVE',
  wind_charged: 'WND', trial_omen: 'TRL', raid_omen: 'RAD',
};

/** Boss bar colour keywords style.css already ships a class for. */
const BOSS_COLOR_CLASSES = new Set(['pink', 'blue', 'red', 'green', 'yellow', 'purple', 'white']);

const cssHex = (c) => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');

// ---------------------------------------------------------------------------
// Tiny DOM helpers. All of them are write-if-changed.
// ---------------------------------------------------------------------------

/** Creates an element with a class and appends it to `parent`. */
function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/** Sets textContent only when it differs, to avoid needless layout work. */
function setText(node, text) {
  const s = text == null ? '' : String(text);
  if (node && node.__t !== s) { node.__t = s; node.textContent = s; }
}

/** Sets a CSS custom property only when the string form changed. */
function setVar(node, name, value) {
  if (!node) return;
  const s = String(value);
  if (!node.__v) node.__v = Object.create(null);
  if (node.__v[name] === s) return;
  node.__v[name] = s;
  node.style.setProperty(name, s);
}

/** Sets className only when it differs. */
function setClass(node, cls) {
  if (node && node.className !== cls) node.className = cls;
}

/** display:none via the [hidden] rule in style.css, write-if-changed. */
function setHidden(node, hidden) {
  if (node && node.hidden !== !!hidden) node.hidden = !!hidden;
}

/** Restarts a CSS animation by removing the class, forcing reflow and re-adding. */
function restartAnim(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  // Reading offsetWidth flushes style so the animation re-runs from frame 0.
  void node.offsetWidth;
  node.classList.add(cls);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

/**
 * Builds and drives every in-world overlay: crosshair, hotbar, hearts, hunger,
 * armour, air, XP, boss bars, status effects, action bar, titles and the
 * full-screen tints.
 */
export class HUD {
  /** @param {HTMLElement} root the `#hud` layer element */
  constructor(root) {
    this.root = root || document.createElement('div');

    // --- visibility state -------------------------------------------------
    /** Set false by hide(), true by show(). */
    this.enabled = true;
    /** F1 toggle. */
    this.guiHidden = false;
    /** Whether the widget layer is currently on screen (null = not yet decided). */
    this.visible = null;

    // --- timers -----------------------------------------------------------
    this._t = 0;
    this._slow = SLOW_POLL;
    this._itemNameTimer = 0;
    this._actionTimer = 0;
    this._titleTimer = 0;
    this._titleState = 'idle';   // idle | in | hold | out
    this._levelUpTimer = 0;
    this._beatTimer = 0;
    this._hitTimer = 0;

    // --- caches (compare-before-write) ------------------------------------
    this._last = {
      invVersion: -1, selected: -1, itemSig: '',
      hp: -1, absorb: -1, maxHp: -1, variant: '',
      hunger: -1, hungry: false, armor: -1, air: -1, maxAir: -1,
      xp: -1, level: -1, effectKey: '', crosshairStyle: '',
      regenBob: -1, shaking: false, lowHealth: false,
    };
    this._heartState = new Array(ROW).fill('');
    this._foodState = new Array(ROW).fill('');
    this._armorState = new Array(ROW).fill('');
    this._bubbleState = new Array(ROW).fill('');
    this._slotSig = new Array(HOTBAR_SIZE).fill(null);

    /** Manual + auto boss bars, keyed by name. Insertion order is display order. */
    this._bosses = new Map();
    /** The block/entity under the crosshair, set by setCrosshairTarget(). */
    this._target = null;
    this._targetIsEntity = false;
    this._prevAttackStrength = 1;

    this._build();
    this._wire();
    this._applyVisibility(false);
  }

  // =========================================================================
  // Construction
  // =========================================================================

  /** Builds the entire DOM tree once. Nothing here runs again. */
  _build() {
    const root = this.root;
    root.textContent = '';

    // ---- full-screen tints (behind the widgets) --------------------------
    this.fx = {
      vignette: el('div', 'fx-vignette', root),
      underwater: el('div', 'fx-underwater', root),
      lava: el('div', 'fx-lava', root),
      portal: el('div', 'fx-portal', root),
      freeze: el('div', 'fx-freeze', root),
      nausea: el('div', 'fx-nausea', root),
      blind: el('div', 'fx-blind', root),
      damage: el('div', 'fx-damage', root),
    };
    for (const k in this.fx) if (k !== 'vignette') setVar(this.fx[k], '--fx', 0);

    // ---- widget layer ----------------------------------------------------
    const layer = el('div', 'hud-layer', root);
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.zIndex = '5';
    layer.style.pointerEvents = 'none';
    this.layer = layer;

    // Boss bars, top centre.
    this.bossBars = el('div', 'boss-bars', layer);

    // Status effects, top right.
    this.effectIcons = el('div', 'effect-icons', layer);

    // Crosshair + attack strength indicator, dead centre.
    this.crosshair = el('div', 'crosshair', layer);
    this.crosshairCooldown = el('div', 'crosshair-cooldown', layer);
    setHidden(this.crosshairCooldown, true);

    // The big centred title card (advancements, /title).
    this.titleCard = el('div', 'hud-title-card', layer);
    const tc = this.titleCard.style;
    tc.position = 'absolute';
    tc.left = '50%';
    tc.top = '36%';
    tc.transform = 'translate(-50%, -50%)';
    tc.textAlign = 'center';
    tc.pointerEvents = 'none';
    tc.opacity = '0';
    tc.transition = 'opacity 0.25s linear';
    tc.whiteSpace = 'pre-line';
    this.titleMain = el('div', 'hud-title-main', this.titleCard);
    this.titleMain.style.fontSize = 'var(--fs-huge)';
    this.titleMain.style.lineHeight = '1.2';
    this.titleMain.style.color = '#ffffff';
    this.titleMain.style.textShadow = 'var(--mc-shadow)';
    this.titleSub = el('div', 'hud-title-sub', this.titleCard);
    this.titleSub.style.fontSize = 'var(--fs-lg)';
    this.titleSub.style.marginTop = 'var(--u4)';
    this.titleSub.style.color = '#e6e6e6';
    this.titleSub.style.textShadow = 'var(--mc-shadow)';
    setHidden(this.titleCard, true);

    // Action bar + held item name, just above the hotbar.
    this.actionBar = el('div', 'action-bar', layer);
    setHidden(this.actionBar, true);
    this.itemName = el('div', 'hotbar-item-name', layer);
    setHidden(this.itemName, true);

    // Armour above hearts (left), air above hunger (right).
    this.armorBar = el('div', 'armor-bar', layer);
    this.hearts = el('div', 'hearts', layer);
    this.airBar = el('div', 'air-bar', layer);
    this.hunger = el('div', 'hunger', layer);

    this.heartEls = [];
    this.foodEls = [];
    this.armorEls = [];
    this.bubbleEls = [];
    for (let i = 0; i < ROW; i++) {
      this.heartEls.push(el('div', 'heart empty', this.hearts));
      this.foodEls.push(el('div', 'food empty', this.hunger));
      this.armorEls.push(el('div', 'armor empty', this.armorBar));
      this.bubbleEls.push(el('div', 'bubble', this.airBar));
    }
    setHidden(this.armorBar, true);
    setHidden(this.airBar, true);

    // XP bar and level number.
    this.xpBar = el('div', 'xp-bar', layer);
    this.xpFill = el('div', 'xp-bar-fill', this.xpBar);
    this.xpLevel = el('div', 'xp-level', layer);
    setHidden(this.xpLevel, true);

    // Hotbar last so it paints over the bars if a tiny window overlaps them.
    this.hotbar = el('div', 'hotbar', layer);
    this.hotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = el('div', 'hotbar-slot', this.hotbar);
      slot.dataset.slot = String(i);
      this.hotbarSlots.push(slot);
    }
    this.hotbarSelector = el('div', 'hotbar-selector', this.hotbar);
    setVar(this.hotbarSelector, '--sel', 0);

    // Clicking a slot selects it - handy with the pointer unlocked and on touch.
    this._onHotbarClick = (ev) => {
      const t = ev.target && ev.target.closest ? ev.target.closest('.hotbar-slot') : null;
      if (!t) return;
      const i = Number(t.dataset.slot);
      if (!Number.isFinite(i)) return;
      const p = Game.player;
      if (p) { p.selectedSlot = i; this._refreshItemName(true); }
      ev.preventDefault();
    };
    this.hotbar.addEventListener('pointerdown', this._onHotbarClick);
  }

  /** Subscribes to the Game events that let us skip polling. */
  _wire() {
    this._offs = [];
    const on = (evt, fn) => {
      try { this._offs.push(Game.on(evt, fn)); } catch { /* bus optional */ }
    };

    on('playerhurt', (amount) => {
      const a = Number(amount) || 0;
      if (a <= 0) return;
      // One style flush for the whole row: strip the classes, read a layout
      // property once, then re-add so every animation restarts together.
      this.fx.damage.classList.remove('flash');
      for (let i = 0; i < ROW; i++) this.heartEls[i].classList.remove('beat');
      void this.layer.offsetWidth;
      this.fx.damage.classList.add('flash');
      for (let i = 0; i < ROW; i++) this.heartEls[i].classList.add('beat');
      this._beatTimer = 0.3;
    });

    on('playerrespawn', () => {
      this._last.hp = -1;
      this._last.invVersion = -1;
      this.clearBossBar();
      this.setActionBar('');
    });

    on('worldloaded', () => {
      this._last.invVersion = -1;
      this._bosses.clear();
      this.bossBars.textContent = '';
      this._slotSig.fill(null);
    });

    on('itempickup', () => { this._last.invVersion = -1; });
    on('craft', () => { this._last.invVersion = -1; });

    on('settingschange', (key) => {
      if (key === 'crosshairStyle') this._last.crosshairStyle = '';
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Shows the HUD (called by main.js once a world is live). */
  show() { this.enabled = true; }

  /** Hides the whole HUD, tints included. */
  hide() {
    this.enabled = false;
    this._applyVisibility(false);
    this._updateFx(null, false);
  }

  /** Toggles the F1 "hide GUI" state and returns the new value. */
  toggleGui() { this.guiHidden = !this.guiHidden; return this.guiHidden; }

  /**
   * Adds or updates a boss bar.
   * @param {string} name label shown above the bar; doubles as the bar's key
   * @param {number} pct 0..1 health fraction
   * @param {string|number} [color] 'pink'|'blue'|'red'|'green'|'yellow'|
   *        'purple'|'white', a css colour string, or a 0xRRGGBB number
   * @param {{notches?:number}} [opts] segment count for raid-style bars
   */
  setBossBar(name, pct, color = 'pink', opts = null) {
    if (!name) return null;
    const key = String(name);
    let bar = this._bosses.get(key);
    if (!bar) {
      const wrap = el('div', 'boss-bar', this.bossBars);
      const label = el('span', 'boss-bar-name', wrap);
      const track = el('div', 'boss-bar-track', wrap);
      const fill = el('div', 'boss-bar-fill', track);
      bar = { wrap, label, track, fill, color: '', notches: 0 };
      this._bosses.set(key, bar);
    }
    setText(bar.label, key.charAt(0) === '#' ? (opts && opts.display) || key.slice(1) : key);
    setVar(bar.fill, '--pct', clamp(Number(pct) || 0, 0, 1).toFixed(3));

    const notches = opts && opts.notches > 1 ? opts.notches | 0 : 0;
    let cls = 'boss-bar';
    if (typeof color === 'string' && BOSS_COLOR_CLASSES.has(color)) cls += ' ' + color;
    if (notches) cls += ' notched';
    setClass(bar.wrap, cls);
    if (notches) setVar(bar.wrap, '--notch', (100 / notches).toFixed(3) + '%');

    if (typeof color === 'number') setVar(bar.wrap, '--boss-color', cssHex(color));
    else if (typeof color === 'string' && !BOSS_COLOR_CLASSES.has(color) && color) {
      setVar(bar.wrap, '--boss-color', color);
    }
    return bar;
  }

  /**
   * Removes one boss bar, or every bar when called with no argument.
   * @param {string} [name]
   */
  clearBossBar(name) {
    if (name == null) {
      this._bosses.clear();
      this.bossBars.textContent = '';
      return;
    }
    const key = String(name);
    const bar = this._bosses.get(key);
    if (!bar) return;
    if (bar.wrap.parentNode) bar.wrap.parentNode.removeChild(bar.wrap);
    this._bosses.delete(key);
  }

  /**
   * Shows a transient line of text above the hotbar. An empty string hides it.
   * @param {string} text
   * @param {number} [seconds] how long to hold before fading
   */
  setActionBar(text, seconds = ACTION_HOLD) {
    const s = text == null ? '' : String(text);
    if (!s) {
      this._actionTimer = 0;
      setHidden(this.actionBar, true);
      return;
    }
    setText(this.actionBar, s);
    setHidden(this.actionBar, false);
    this.actionBar.classList.remove('fading');
    this._actionTimer = Math.max(0.1, seconds) + ACTION_FADE;
  }

  /**
   * The big centred title used by advancements and `/title`.
   * @param {string} title main line ('' clears the card)
   * @param {string} [subtitle] smaller second line
   * @param {number} [ms] hold time in milliseconds
   */
  showTitle(title, subtitle = '', ms = 3000) {
    const main = title == null ? '' : String(title);
    const sub = subtitle == null ? '' : String(subtitle);
    if (!main && !sub) {
      this._titleState = 'idle';
      this._titleTimer = 0;
      this.titleCard.style.opacity = '0';
      setHidden(this.titleCard, true);
      return;
    }
    setText(this.titleMain, main);
    setText(this.titleSub, sub);
    setHidden(this.titleMain, !main);
    setHidden(this.titleSub, !sub);
    setHidden(this.titleCard, false);
    this.titleCard.style.transition = 'opacity 0.25s linear';
    this.titleCard.style.opacity = '0';
    // Force a style flush so the transition to 1 actually animates.
    void this.titleCard.offsetWidth;
    this.titleCard.style.opacity = '1';
    this._titleState = 'hold';
    this._titleTimer = Math.max(0.2, (Number(ms) || 3000) / 1000);
  }

  /**
   * Tells the crosshair what the player is looking at, so the attack-strength
   * indicator can appear over mobs.
   * @param {object|null} entityOrBlock a raycast hit, an Entity, or null
   */
  setCrosshairTarget(entityOrBlock) {
    this._target = entityOrBlock || null;
    const t = this._target;
    this._targetIsEntity = !!(t && (t.isEntity || t.isMob || t.isPlayer ||
      (t.id !== undefined && t.health !== undefined) || t.entity));
  }

  /** Detaches listeners and empties the layer. Not used by main.js, but tidy. */
  destroy() {
    if (this._offs) for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs = [];
    try { this.hotbar.removeEventListener('pointerdown', this._onHotbarClick); } catch { /* ignore */ }
    this.root.textContent = '';
  }

  // =========================================================================
  // Per-frame update
  // =========================================================================

  /**
   * Drives everything. Called once per rendered frame from main.js.
   * @param {number} dt seconds since the previous frame
   */
  update(dt) {
    const d = Number(dt) || 0;
    this._t += d;

    this._pollHideGui();

    const p = Game.player;
    const mode = (p && p.gameMode) || Game.mode;
    const spectator = mode === GAMEMODE.SPECTATOR;
    const live = !!(p && Game.started && this.enabled && !this.guiHidden && !spectator);

    this._applyVisibility(live);
    // Tints stay up in spectator and behind F1 so the world still reads as
    // underwater, but hide() takes everything down.
    this._updateFx(this.enabled ? p : null, spectator);

    if (!live) return;

    this._slow -= d;
    const slowTick = this._slow <= 0;
    if (slowTick) this._slow += SLOW_POLL;

    const survival = mode !== GAMEMODE.CREATIVE;

    this._updateHotbar(p);
    this._updateItemName(p, d);
    this._updateActionBar(d);
    this._updateTitle(d);
    this._updateCrosshair(p, d, mode);
    this._updateHealth(p, survival, d);
    this._updateHunger(p, survival);
    this._updateArmor(p, survival);
    this._updateAir(p, survival);
    this._updateXP(p, survival, d);
    if (slowTick) {
      this._updateEffects(p);
      this._updateBossBars(p);
    }
  }

  // ---- visibility ---------------------------------------------------------

  /** Watches the F1 keybind without stealing it from anyone else. */
  _pollHideGui() {
    const input = Game.input;
    if (!input || typeof input.justPressed !== 'function') return;
    try {
      if (input.justPressed('hidegui')) this.guiHidden = !this.guiHidden;
    } catch { /* keybind table may not be ready */ }
  }

  /** Shows/hides the widget layer without touching individual widgets. */
  _applyVisibility(show) {
    if (this.visible === show) return;
    this.visible = show;
    setHidden(this.layer, !show);
  }

  // ---- hotbar -------------------------------------------------------------

  /** Rebuilds hotbar icons only when the inventory version or a stack changed. */
  _updateHotbar(p) {
    const inv = p.inventory;
    if (!inv) return;

    const sel = clamp(p.selectedSlot | 0, 0, HOTBAR_SIZE - 1);
    if (sel !== this._last.selected) {
      this._last.selected = sel;
      setVar(this.hotbarSelector, '--sel', sel);
    }

    // A missing version counter (a stand-in inventory) yields NaN, which never
    // compares equal, so those fall back to the per-slot signature check.
    const version = typeof inv.version === 'number' ? inv.version : NaN;
    if (version === this._last.invVersion) return;
    this._last.invVersion = version;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      let s = null;
      try { s = inv.get(i); } catch { s = null; }
      const sig = stackSignature(s);
      if (sig === this._slotSig[i]) continue;
      this._slotSig[i] = sig;
      const slot = this.hotbarSlots[i];
      slot.textContent = '';
      if (!s) continue;
      const icon = buildStackIcon(s);
      if (icon) slot.appendChild(icon);
    }
  }

  // ---- held item name -----------------------------------------------------

  /** Pops the item name above the hotbar whenever the held stack changes. */
  _updateItemName(p, dt) {
    let held = null;
    try { held = p.getHeldItem ? p.getHeldItem() : null; } catch { held = null; }
    const sig = held ? (held.item + '|' + (held.name || held.customName || '')) : '';

    if (sig !== this._last.itemSig) {
      this._last.itemSig = sig;
      this._refreshItemName(false, held);
    }

    if (this._itemNameTimer > 0) {
      this._itemNameTimer -= dt;
      if (this._itemNameTimer <= ITEM_NAME_FADE) this.itemName.classList.add('fading');
      if (this._itemNameTimer <= 0) setHidden(this.itemName, true);
    }
  }

  /** (Re)shows the item name popup. */
  _refreshItemName(force, held) {
    const p = Game.player;
    if (!p) return;
    let s = held;
    if (s === undefined) s = null;
    if (!s && force !== 'empty') {
      try { s = p.getHeldItem ? p.getHeldItem() : null; } catch { s = null; }
    }
    if (!s) {
      this._itemNameTimer = 0;
      setHidden(this.itemName, true);
      return;
    }
    let name = s.item;
    let rarity = 'common';
    try { name = stackDisplayName(s) || prettyName(s.item); } catch { name = prettyName(s.item); }
    try { rarity = stackRarity(s) || 'common'; } catch { rarity = 'common'; }
    setText(this.itemName, name);
    setClass(this.itemName, 'hotbar-item-name' + (rarity === 'common' ? '' : ' rarity-' + rarity));
    setHidden(this.itemName, false);
    this._itemNameTimer = ITEM_NAME_HOLD + ITEM_NAME_FADE;
  }

  // ---- action bar ---------------------------------------------------------

  /** Counts the action bar down and fades it out. */
  _updateActionBar(dt) {
    if (this._actionTimer <= 0) return;
    this._actionTimer -= dt;
    if (this._actionTimer <= ACTION_FADE) this.actionBar.classList.add('fading');
    if (this._actionTimer <= 0) setHidden(this.actionBar, true);
  }

  // ---- title card ---------------------------------------------------------

  /** Simple hold -> fade-out state machine for showTitle(). */
  _updateTitle(dt) {
    if (this._titleState === 'idle') return;
    this._titleTimer -= dt;
    if (this._titleTimer > 0) return;
    if (this._titleState === 'hold') {
      this._titleState = 'out';
      this._titleTimer = 0.6;
      this.titleCard.style.transition = 'opacity 0.6s linear';
      this.titleCard.style.opacity = '0';
    } else {
      this._titleState = 'idle';
      this.titleCard.style.transition = 'opacity 0.25s linear';
      setHidden(this.titleCard, true);
    }
  }

  // ---- crosshair ----------------------------------------------------------

  /** Crosshair style, hit bloom and the attack-strength bar underneath it. */
  _updateCrosshair(p, dt, mode) {
    // Style comes from settings; 'none' hides it entirely.
    let style = 'cross';
    try { style = Game.settings?.get('crosshairStyle') || 'cross'; } catch { style = 'cross'; }
    if (style !== this._last.crosshairStyle) {
      this._last.crosshairStyle = style;
      setClass(this.crosshair, 'crosshair' + (style === 'dot' || style === 'circle' ? ' dot' : ''));
      setHidden(this.crosshair, style === 'none');
    }

    // A screen (inventory, chest, pause) owns the cursor: no crosshair.
    let screenOpen = false;
    try {
      screenOpen = !!(p.screen) ||
        !!(Game.ui?.screens?.isOpen && Game.ui.screens.isOpen()) ||
        !!(Game.ui?.menu && Game.ui.menu.visible);
    } catch { screenOpen = false; }
    if (style !== 'none') setHidden(this.crosshair, screenOpen);

    // Mirror the player's own hit result when nobody pushed a target at us.
    if (!this._target && p.hitResult) {
      this._targetIsEntity = !!p.hitResult.entity;
    }

    // Attack strength: 0 right after a swing, 1 when the weapon is recharged.
    let strength = 1;
    try {
      strength = p.attackIndicator !== undefined
        ? p.attackIndicator
        : (typeof p.getAttackStrength === 'function' ? p.getAttackStrength() : 1);
    } catch { strength = 1; }
    strength = clamp(Number(strength) || 0, 0, 1);

    // A swing just landed on a mob -> flash the crosshair.
    if (this._prevAttackStrength > 0.85 && strength < 0.25 && this._targetIsEntity) {
      restartAnim(this.crosshair, 'hit');
      this._hitTimer = 0.3;
    }
    this._prevAttackStrength = strength;
    if (this._hitTimer > 0) {
      this._hitTimer -= dt;
      if (this._hitTimer <= 0) this.crosshair.classList.remove('hit');
    }

    const showCooldown = !screenOpen && mode !== GAMEMODE.CREATIVE &&
      mode !== GAMEMODE.SPECTATOR && (strength < 0.999 || this._targetIsEntity);
    setHidden(this.crosshairCooldown, !showCooldown);
    if (showCooldown) setVar(this.crosshairCooldown, '--cool', strength.toFixed(3));
  }

  // ---- hearts -------------------------------------------------------------

  /** Hearts, their variant colour, the regeneration bob and the low-health blink. */
  _updateHealth(p, survival, dt) {
    if (!survival) {
      setHidden(this.hearts, true);
      return;
    }
    setHidden(this.hearts, false);

    const maxHp = Math.max(1, Number(p.maxHealth) || MAX_HEALTH);
    const scale = MAX_HEALTH / maxHp;                 // squeeze health-boost into 10 hearts
    const hp = clamp(Number(p.health) || 0, 0, maxHp);
    const hpUnits = Math.ceil(hp * scale);            // 0..20 half-hearts
    const absUnits = Math.ceil(clamp(Number(p.absorption) || 0, 0, 40) * scale);

    // Which sprite variant the filled half uses.
    let variant = '';
    try {
      const frozen = Math.max(p.freezeTicks | 0, p.frozenTicks | 0) >= FREEZE_TICKS;
      if (frozen) variant = 'frozen';
      else if (p.hasEffect && p.hasEffect('wither')) variant = 'wither';
      else if (p.hasEffect && p.hasEffect('poison')) variant = 'poison';
    } catch { variant = ''; }

    // Regeneration lifts one heart at a time, sweeping left to right.
    let bob = -1;
    try {
      if (p.hasEffect && p.hasEffect('regeneration')) bob = (Game.ticks | 0) % (ROW + 5);
    } catch { bob = -1; }

    const low = hp <= 4;
    if (low !== this._last.lowHealth) {
      this._last.lowHealth = low;
      this.hearts.classList.toggle('low', low);
    }

    const dirty = hpUnits !== this._last.hp || absUnits !== this._last.absorb ||
      variant !== this._last.variant || maxHp !== this._last.maxHp;

    if (dirty) {
      this._last.hp = hpUnits;
      this._last.absorb = absUnits;
      this._last.variant = variant;
      this._last.maxHp = maxHp;

      const absStart = hpUnits;
      const absEnd = Math.min(ROW * 2, hpUnits + absUnits);
      for (let i = 0; i < ROW; i++) {
        const base = i * 2;
        const red = clamp(hpUnits - base, 0, 2);
        const goldRoom = 2 - red;
        const gold = clamp(Math.min(absEnd, base + 2) - Math.max(absStart, base), 0, goldRoom);
        let cls = 'heart';
        if (red >= 2) cls += variant ? ' ' + variant : '';
        else if (red === 1) cls += ' half' + (variant ? ' ' + variant : '');
        else if (gold >= 2) cls += ' absorption';
        else if (gold === 1) cls += ' half absorption';
        else cls += ' empty';
        if (cls !== this._heartState[i]) {
          this._heartState[i] = cls;
          // Preserve the transient .beat class the hurt event added.
          const beating = this.heartEls[i].classList.contains('beat');
          setClass(this.heartEls[i], beating ? cls + ' beat' : cls);
        }
      }
    }

    if (bob !== this._last.regenBob) {
      const prev = this._last.regenBob;
      this._last.regenBob = bob;
      if (prev >= 0 && prev < ROW) this.heartEls[prev].style.marginTop = '';
      if (bob >= 0 && bob < ROW) this.heartEls[bob].style.marginTop = 'calc(var(--gs) * -1px)';
    }

    if (this._beatTimer > 0) {
      this._beatTimer -= dt;
      if (this._beatTimer <= 0) {
        for (let i = 0; i < ROW; i++) this.heartEls[i].classList.remove('beat');
      }
    }
  }

  // ---- hunger -------------------------------------------------------------

  /** Drumsticks, the rotten-flesh tint and the starving jitter. */
  _updateHunger(p, survival) {
    if (!survival) {
      setHidden(this.hunger, true);
      return;
    }
    setHidden(this.hunger, false);

    const food = clamp(Number(p.hunger) || 0, 0, MAX_HUNGER);
    const units = Math.ceil(food * (20 / MAX_HUNGER));
    let hungry = false;
    try { hungry = !!(p.hasEffect && p.hasEffect('hunger')); } catch { hungry = false; }

    if (units !== this._last.hunger || hungry !== this._last.hungry) {
      this._last.hunger = units;
      this._last.hungry = hungry;
      for (let i = 0; i < ROW; i++) {
        const filled = clamp(units - i * 2, 0, 2);
        let cls = 'food';
        if (filled >= 2) cls += hungry ? ' hungry' : '';
        else if (filled === 1) cls += ' half' + (hungry ? ' hungry' : '');
        else cls += ' empty';
        if (cls !== this._foodState[i]) {
          this._foodState[i] = cls;
          setClass(this.foodEls[i], cls);
        }
      }
    }

    // Vanilla shakes the icons once saturation runs out; the period shortens
    // as the food bar empties, so a nearly-starved player rattles constantly.
    const sat = Number(p.saturation) || 0;
    const shaking = sat <= 0 && food < MAX_HUNGER;
    if (shaking) {
      const period = Math.max(1, (food | 0) * 3 + 1);
      if (((Game.ticks | 0) % period) === 0) {
        for (let i = 0; i < ROW; i++) {
          const off = (Math.random() * 3 | 0) - 1;
          this.foodEls[i].style.marginBottom = off ? `calc(var(--gs) * ${off}px)` : '';
        }
      }
    } else if (this._last.shaking) {
      for (let i = 0; i < ROW; i++) this.foodEls[i].style.marginBottom = '';
    }
    this._last.shaking = shaking;
  }

  // ---- armour -------------------------------------------------------------

  /** Ten armour icons; the row disappears entirely at zero points. */
  _updateArmor(p, survival) {
    let points = 0;
    try {
      points = typeof p.getArmorPoints === 'function'
        ? p.getArmorPoints()
        : (p.inventory && typeof p.inventory.armorPoints === 'function' ? p.inventory.armorPoints() : 0);
    } catch { points = 0; }
    points = clamp(points | 0, 0, 20);

    const show = survival && points > 0;
    setHidden(this.armorBar, !show);
    if (!show || points === this._last.armor) { this._last.armor = points; return; }
    this._last.armor = points;

    for (let i = 0; i < ROW; i++) {
      const filled = clamp(points - i * 2, 0, 2);
      const cls = 'armor' + (filled >= 2 ? '' : filled === 1 ? ' half' : ' empty');
      if (cls !== this._armorState[i]) {
        this._armorState[i] = cls;
        setClass(this.armorEls[i], cls);
      }
    }
  }

  // ---- air ----------------------------------------------------------------

  /** Bubbles appear only while the player is short of breath. */
  _updateAir(p, survival) {
    const maxAir = Math.max(1, Number(p.maxAirSupply) || MAX_AIR);
    const raw = Number(p.airSupply);
    const air = clamp(Number.isFinite(raw) ? raw : maxAir, 0, maxAir);
    const show = survival && air < maxAir;
    setHidden(this.airBar, !show);
    if (!show) { this._last.air = -1; return; }

    const full = Math.ceil(air * ROW / maxAir);
    if (full === this._last.air && maxAir === this._last.maxAir) return;
    this._last.air = full;
    this._last.maxAir = maxAir;

    // The bubble just past the full run is the one bursting; at zero air there
    // is nothing left to burst.
    const popIndex = air > 0 && full < ROW ? full : -1;
    for (let i = 0; i < ROW; i++) {
      const cls = i === popIndex ? 'bubble pop' : 'bubble';
      if (cls !== this._bubbleState[i]) {
        this._bubbleState[i] = cls;
        setClass(this.bubbleEls[i], cls);
      }
      setHidden(this.bubbleEls[i], i >= full && i !== popIndex);
    }
  }

  // ---- experience ---------------------------------------------------------

  /** XP bar fill plus the level number and its level-up pop. */
  _updateXP(p, survival, dt) {
    const show = survival;
    setHidden(this.xpBar, !show);
    if (!show) {
      setHidden(this.xpLevel, true);
      // Force a rebuild when survival comes back, since the row was torn down.
      this._last.level = -1;
      return;
    }

    const prog = clamp(Number(p.xpProgress) || 0, 0, 1);
    const key = Math.round(prog * 1000);
    if (key !== this._last.xp) {
      this._last.xp = key;
      setVar(this.xpFill, '--xp', (key / 1000).toFixed(3));
    }

    const level = Math.max(0, p.xpLevel | 0);
    if (level !== this._last.level) {
      const rose = level > this._last.level && this._last.level >= 0;
      this._last.level = level;
      setText(this.xpLevel, level > 0 ? String(level) : '');
      setHidden(this.xpLevel, level <= 0);
      if (rose && level > 0) {
        restartAnim(this.xpLevel, 'levelup');
        this._levelUpTimer = 0.75;
      }
    }
    if (this._levelUpTimer > 0) {
      this._levelUpTimer -= dt;
      if (this._levelUpTimer <= 0) this.xpLevel.classList.remove('levelup');
    }
  }

  // ---- status effects -----------------------------------------------------

  /**
   * Rebuilds the effect row when the set of effects changes and only rewrites
   * the countdown text otherwise.
   */
  _updateEffects(p) {
    let list = [];
    try { list = activeEffects(p) || []; } catch { list = []; }

    // Identity of the row: which effects, at which level, ambient or not.
    let key = '';
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      key += e.name + ':' + e.amplifier + (e.ambient ? 'a' : '') + ';';
    }

    if (key !== this._last.effectKey) {
      this._last.effectKey = key;
      this.effectIcons.textContent = '';
      this._effectNodes = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const def = e.def || {};
        let cls = 'effect-icon';
        if (e.ambient) cls += ' ambient';
        if (def.harmful) cls += ' bad';
        const box = el('div', cls, this.effectIcons);
        try { box.title = effectDisplayName(e.name, e.amplifier); } catch { box.title = e.name; }
        const glyph = el('div', 'effect-icon-glyph', box);
        setVar(glyph, '--effect-color', cssHex(def.color === undefined ? 0x7a5cff : def.color));
        setText(glyph, EFFECT_GLYPH[e.name] || abbreviate(e.name));
        const time = el('div', 'effect-icon-time', box);
        this._effectNodes.push({ box, time, level: e.amplifier });
      }
    }

    const nodes = this._effectNodes || [];
    for (let i = 0; i < nodes.length && i < list.length; i++) {
      const e = list[i];
      const n = nodes[i];
      let t = '';
      try { t = formatEffectTime(e.ticks); } catch { t = ''; }
      setText(n.time, n.level > 0 ? roman(n.level + 1) + ' ' + t : t);
      const expiring = e.ticks >= 0 && e.ticks < EXPIRING_TICKS;
      if (n.expiring !== expiring) {
        n.expiring = expiring;
        n.box.classList.toggle('expiring', expiring);
      }
    }
  }

  // ---- boss bars ----------------------------------------------------------

  /** Mirrors nearby boss mobs into auto-managed bars, leaving manual bars alone. */
  _updateBossBars(p) {
    const world = Game.world;
    if (!world || !Array.isArray(world.entities)) return;

    const seen = new Set();
    const list = world.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.removed || e.dead) continue;
      const def = e.def;
      if (!def || !def.boss) continue;
      const dx = e.x - p.x, dy = e.y - p.y, dz = e.z - p.z;
      if (dx * dx + dy * dy + dz * dz > 160 * 160) continue;
      const key = '#boss' + e.id;
      seen.add(key);
      const max = Math.max(1, Number(e.maxHealth) || 1);
      const pct = clamp((Number(e.health) || 0) / max, 0, 1);
      this.setBossBar(key, pct, def.bossColor === undefined ? 'purple' : def.bossColor, {
        display: def.bossName || def.display || prettyName(def.name || 'boss'),
      });
    }

    // Drop auto bars whose boss is gone; never touch manually added ones.
    for (const key of [...this._bosses.keys()]) {
      if (key.charAt(0) === '#' && key.startsWith('#boss') && !seen.has(key)) this.clearBossBar(key);
    }
  }

  // ---- full-screen tints --------------------------------------------------

  /** Drives the eight overlay opacities from the player's current state. */
  _updateFx(p, spectator) {
    const fx = this.fx;
    if (!fx) return;

    if (!p || !Game.started) {
      setVar(fx.underwater, '--fx', 0);
      setVar(fx.lava, '--fx', 0);
      setVar(fx.portal, '--fx', 0);
      setVar(fx.freeze, '--fx', 0);
      setVar(fx.nausea, '--fx', 0);
      setVar(fx.blind, '--fx', 0);
      setVar(fx.vignette, '--fx', 0);
      return;
    }
    setVar(fx.vignette, '--fx', spectator ? 0.4 : 1);

    const inLavaEyes = !!p.submergedInLava;
    const inWaterEyes = !!p.submerged && !inLavaEyes;
    setVar(fx.underwater, '--fx', inWaterEyes ? 1 : 0);
    // Vanilla only paints lava when the eyes are under it; being on fire gets
    // a much weaker version of the same orange wash.
    setVar(fx.lava, '--fx', inLavaEyes ? 1 : ((p.fireTicks | 0) > 0 ? 0.28 : 0));

    const portal = clamp((p.portalTicks | 0) / PORTAL_TICKS, 0, 1);
    setVar(fx.portal, '--fx', portal.toFixed(2));

    const freeze = clamp(Math.max(p.freezeTicks | 0, p.frozenTicks | 0) / FREEZE_TICKS, 0, 1);
    setVar(fx.freeze, '--fx', freeze.toFixed(2));

    let nausea = 0, blind = 0;
    try {
      if (p.hasEffect) {
        if (p.hasEffect('nausea')) nausea = 1;
        if (p.hasEffect('blindness')) blind = 1;
        else if (p.hasEffect('darkness')) blind = 0.75;
      }
    } catch { nausea = 0; blind = 0; }
    setVar(fx.nausea, '--fx', nausea);
    setVar(fx.blind, '--fx', blind);
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/** Cheap change-detection key for one hotbar stack. */
function stackSignature(s) {
  if (!s || !s.item || (s.count | 0) <= 0) return '';
  return s.item + '|' + (s.count | 0) + '|' + (s.damage | 0) +
    (s.enchants || s.enchantments ? '|e' : '') +
    (s.name || s.customName ? '|' + (s.name || s.customName) : '');
}

/**
 * Builds the DOM icon for a hotbar stack. Prefers itemrender's `stackElement`
 * (it already does glint, durability and count) and falls back to a raw canvas
 * drawn with `drawStack` if that module is unhappy.
 */
function buildStackIcon(s) {
  try {
    const node = stackElement(s, 32);
    if (node) {
      // Let .hotbar-slot > .stack-icon size the icon from --slot-icon instead
      // of the inline pixel size stackElement bakes in.
      node.style.width = '';
      node.style.height = '';
      return node;
    }
  } catch { /* fall through to the canvas path */ }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    canvas.className = 'pixel';
    const ctx = canvas.getContext('2d');
    if (ctx) drawStack(ctx, s, 0, 0, 64);
    return canvas;
  } catch {
    return null;
  }
}

/** Three-letter fallback glyph for an unregistered effect name. */
function abbreviate(name) {
  const parts = String(name || '').split('_').filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase();
  return parts.map((w) => w.charAt(0)).join('').slice(0, 3).toUpperCase();
}

export default HUD;
