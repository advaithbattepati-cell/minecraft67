// ============================================================================
// screens.js - Every container / workstation screen (CONTRACT.md section 28).
//
// One shared framework does the heavy lifting:
//
//   * `Slot`      - a bound view onto (inventory, index) with vanilla mouse
//                   semantics: pick up, place, split, quick-move, drag-spread,
//                   double-click gather, and hotbar number swaps.
//   * `Screens`   - mounts one screen at a time into `#screens`, owns the
//                   cursor stack, the tooltip and the keyboard.
//
// Individual screens are pure builders: they lay out DOM (using only the class
// names in src/ui/style.css), register slots and hand back a couple of hooks.
//
// Everything here is defensive: a missing neighbour module degrades one
// widget, never the whole screen.
// ============================================================================
import { Game } from '../core/game.js';
import {
  HOTBAR_SIZE, INV_MAIN_SIZE, ARMOR_SLOTS, GAMEMODE, TICK_MS,
} from '../core/constants.js';
import { clamp, prettyName } from '../core/util.js';

import { getBlock } from '../world/blocks.js';
import {
  Inventory, stack as mkStack, isEmpty, sameItem, copyStack, maxStackSize,
  stackDisplayName, stackTooltipLines, stackRarity, transferStack, sanitizeStack,
  ARMOR_SLOT_START, OFFHAND_SLOT,
} from '../item/inventory.js';
import { ITEMS, ITEM_NAMES, CREATIVE_TABS, getItem } from '../item/items.js';
import {
  matchRecipe, remainingItems, craftableFrom, RECIPES, TAGS,
  stonecuttingFor, smithingResult,
} from '../item/recipes.js';
import {
  smeltResult, smeltXp, fuelTicks, isFuel, fuelRemainder, KIND_TIME,
} from '../item/smelting.js';
import {
  tickBrewingStand, brewProgress, isBrewFuel, isValidBrewIngredient, isPotionItem,
  BREW_FUEL_USES, BREW_SLOT_INGREDIENT, BREW_SLOT_FUEL, BREW_BOTTLE_COUNT,
} from '../item/brewing.js';
import {
  tableOffers, applyOffer, anvilResult, grindstoneResult, countBookshelves,
  MAX_BOOKSHELVES,
} from '../item/enchanting.js';
import {
  levelProgress, tradeInStock, canUseTrade, useTrade, refuseTrade, tradePrice,
  ensureTrades, tradeStackName,
} from '../item/trading.js';
import { stackElement, iconDataURL } from '../render/itemrender.js';
import { getSkin } from '../render/skins.js';

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

/** A `.mc-button` wired to a click handler. */
function button(label, parent, onClick, cls) {
  const b = el('button', 'mc-button' + (cls ? ' ' + cls : ''), parent, label);
  b.type = 'button';
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    click();
    try { onClick(ev); } catch (err) { console.error('[screens] button', err); }
  });
  return b;
}

/** Points an <img> at an item icon, leaving it blank when none could be baked. */
function setIcon(img, itemName) {
  let url = '';
  try { url = iconDataURL(itemName) || ''; } catch { url = ''; }
  if (url) img.src = url;
  img.alt = '';
  img.draggable = false;
  return img;
}

/** True for DOM the browser should handle itself (focus, scroll, buttons). */
function isInteractive(target) {
  let n = target;
  for (let i = 0; i < 8 && n && n.nodeType === 1; i++) {
    const tag = n.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT') return true;
    if (n.classList && (n.classList.contains('mc-scroll') || n.classList.contains('recipe-results')
      || n.classList.contains('trade-list'))) return true;
    n = n.parentElement;
  }
  return false;
}

/** Fire-and-forget UI sound; the audio engine is optional. */
function sound(name, volume = 0.5, pitch = 1) {
  const a = Game.audio;
  if (!a || typeof a.play !== 'function') return;
  try { a.play(name, { volume, pitch }); } catch { /* audio is optional */ }
}
const click = () => sound('click', 0.35, 1);

/** The active player, whatever the caller passed. */
function playerOf(ctx) {
  return (ctx && ctx.player) || Game.player || null;
}

/** True in creative/spectator, where costs and stock do not apply. */
function isCreative(player) {
  const mode = (player && player.gameMode) || Game.mode;
  return mode === GAMEMODE.CREATIVE || mode === GAMEMODE.SPECTATOR;
}

/** A stack's max size, guarding against a missing item definition. */
function maxOf(s) {
  try { return Math.max(1, maxStackSize(s) | 0); } catch { return 64; }
}

// ---------------------------------------------------------------------------
// Block-entity backed inventories
// ---------------------------------------------------------------------------

/**
 * An Inventory whose slot array *is* the block entity's array, so writes land
 * straight in the saved world. `be.items` and `be.slots` are aliased to the
 * same array because different modules reach for different names.
 */
function beInventory(world, x, y, z, size, name) {
  let be = null;
  try { be = world && world.getBlockEntity ? world.getBlockEntity(x, y, z) : null; } catch { be = null; }
  if (!be) {
    be = { type: 'container', block: name || 'container', x, y, z };
    try { if (world && world.setBlockEntity) world.setBlockEntity(x, y, z, be); } catch { /* transient */ }
  }
  let arr = Array.isArray(be.items) ? be.items : (Array.isArray(be.slots) ? be.slots : null);
  if (!arr) arr = new Array(size).fill(null);
  while (arr.length < size) arr.push(null);
  for (let i = 0; i < arr.length; i++) arr[i] = sanitizeStack(arr[i]);
  be.items = arr;
  be.slots = arr;

  const inv = new Inventory(arr.length, name || '');
  inv.slots = arr;
  inv.size = arr.length;
  inv.be = be;
  inv.onChange = () => {
    be.dirty = true;
    try {
      const c = world && world.chunkAt ? world.chunkAt(x, z) : null;
      if (c) c.modified = true;
    } catch { /* chunk bookkeeping is optional */ }
  };
  return inv;
}

/** Two block-entity inventories presented as one 54-slot chest. */
function doubleInventory(a, b, name) {
  const inv = new Inventory(a.size + b.size, name);
  for (let i = 0; i < a.size; i++) inv.slots[i] = a.slots[i];
  for (let i = 0; i < b.size; i++) inv.slots[a.size + i] = b.slots[i];
  inv.onChange = () => {
    for (let i = 0; i < a.size; i++) a.slots[i] = inv.slots[i];
    for (let i = 0; i < b.size; i++) b.slots[i] = inv.slots[a.size + i];
    a.markChanged(-1);
    b.markChanged(-1);
  };
  return inv;
}

// ---------------------------------------------------------------------------
// Standard-Galactic flavour text for the enchanting table
// ---------------------------------------------------------------------------

const GALACTIC_WORDS = [
  'nihil', 'audentia', 'stellae', 'ignis', 'umbra', 'vortex', 'aether', 'runa',
  'grima', 'thaum', 'orbis', 'vesper', 'lumen', 'arcanum', 'nox', 'sator',
  'arepo', 'tenet', 'opera', 'rotas', 'xarn', 'quor', 'vel', 'duran', 'wynn',
  'elder', 'sceal', 'mund', 'haelan', 'ethel', 'beorc', 'ing', 'lagu', 'peorth',
];

/** Deterministic gibberish "enchantment clue" for one offer row. */
function galacticText(seed, wordCount = 3) {
  let h = (seed >>> 0) || 1;
  const next = () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h;
  };
  const out = [];
  for (let i = 0; i < wordCount; i++) out.push(GALACTIC_WORDS[next() % GALACTIC_WORDS.length]);
  return out.join(' ');
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

/**
 * One clickable inventory slot. All mouse semantics live in Screens; a Slot
 * only knows how to read, write and validate its own contents.
 */
class Slot {
  constructor(cfg = {}) {
    this.inv = cfg.inv || null;
    this.index = cfg.index | 0;
    this.getFn = cfg.get || null;
    this.setFn = cfg.set || null;
    this.filter = cfg.filter || null;
    this.takeOnly = !!cfg.takeOnly;
    this.readOnly = !!cfg.readOnly;
    this.onTaken = cfg.onTaken || null;      // (takenStack) after a take-only pull
    this.onChanged = cfg.onChanged || null;  // after any write
    this.quick = cfg.quick || null;          // custom shift-click, returns true if handled
    this.maxTake = cfg.maxTake || 0;         // hard cap on a single take (0 = stack size)
    this.limit = cfg.limit || 0;             // hard cap on what the slot may hold
    this.group = cfg.group || '';            // used by the default quick-move router

    const e = document.createElement('div');
    e.className = 'mc-slot' + (cfg.className ? ' ' + cfg.className : '');
    e.__slot = this;
    this.el = e;
    if (cfg.parent) cfg.parent.appendChild(e);
    this._sig = null;
  }

  /** Current contents, or null. */
  get() {
    try {
      if (this.getFn) return this.getFn();
      return this.inv ? this.inv.get(this.index) : null;
    } catch { return null; }
  }

  /** Writes the slot. */
  set(s) {
    try {
      if (this.setFn) this.setFn(s);
      else if (this.inv) this.inv.set(this.index, isEmpty(s) ? null : s);
      if (this.onChanged) this.onChanged();
    } catch (err) { console.error('[screens] slot write', err); }
  }

  /** True when the player may pull items out. */
  canTake() { return !this.readOnly; }

  /** True when `s` may be dropped in here. */
  canPlace(s) {
    if (this.readOnly || this.takeOnly || isEmpty(s)) return false;
    if (this.filter) { try { if (!this.filter(s)) return false; } catch { return false; } }
    if (this.inv && typeof this.inv.canAccept === 'function') {
      try { if (!this.inv.canAccept(this.index, s)) return false; } catch { /* permissive */ }
    }
    return true;
  }

  /** Ceiling for this slot: the item's stack size, or an explicit limit. */
  capacity(s) {
    const m = maxOf(s);
    return this.limit > 0 ? Math.min(this.limit, m) : m;
  }

  /** Redraws the icon when the contents changed. */
  render() {
    const s = this.get();
    const sig = s ? `${s.item}|${s.count}|${s.damage || 0}|${s.enchants ? 1 : 0}|${s.customName || ''}` : '';
    if (sig === this._sig) return;
    this._sig = sig;
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    this.el.classList.toggle('filled', !!s);
    if (!s) return;
    try {
      this.el.appendChild(stackElement(s, 32));
    } catch (err) {
      // A broken icon must never take the whole screen down with it.
      const fallback = document.createElement('div');
      fallback.className = 'stack-icon';
      fallback.textContent = (s.count | 0) > 1 ? String(s.count) : '?';
      this.el.appendChild(fallback);
    }
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/**
 * Owns every container screen. `open(name, ctx)` mounts one, releases the
 * pointer lock and silences player input; `close()` puts everything back.
 */
export class Screens {
  /** @param {HTMLElement} root the `#screens` layer */
  constructor(root) {
    this.root = root || document.getElementById('screens') || document.body;
    /** Currently open screen name, or null. */
    this.current = null;
    /** The ctx object `open()` was called with. */
    this.ctx = null;

    this.overlay = null;
    this.screenEl = null;
    this.slots = [];
    this.watched = [];           // [inventory, lastVersion]
    this.temps = [];             // scratch inventories emptied back into the player on close
    this.hooks = { refresh: null, tick: null, frame: null, dispose: null };

    this.held = null;            // the stack glued to the cursor
    this.heldEl = null;
    this.tooltipEl = null;
    this.hoverSlot = null;
    this.mouseX = 0;
    this.mouseY = 0;

    this._drag = null;
    this._lastClick = { time: 0, item: null, slot: null };
    this._accum = 0;
    this._cleanups = [];
    this._keyHandler = (e) => this._onKey(e);
    this._moveHandler = (e) => this._onMouseMove(e);
    this._upHandler = (e) => this._onMouseUp(e);
    this._wasPointerLocked = false;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** True while a screen is mounted. */
  isOpen() { return this.current !== null; }

  /**
   * Mounts a screen by name.
   * @param {string} name one of the names listed in CONTRACT.md section 28
   * @param {object} ctx  { player, world, x, y, z, block, villager, container, ... }
   */
  open(name, ctx = {}) {
    if (!name) return false;
    if (this.current) this.close(true);

    this.current = name;
    this.ctx = ctx || {};
    this.slots = [];
    this.watched = [];
    this.temps = [];
    this._cleanups = [];
    this.hooks = { refresh: null, tick: null, frame: null, dispose: null };
    this._accum = 0;
    this._lastClick = { time: 0, item: null, slot: null };

    const player = playerOf(this.ctx);
    if (player && player.inventory) this.held = player.inventory.cursor || null;

    // Hand the pointer back to the player before anything else, so the
    // pointer-lock change handler in main.js sees a screen already open and
    // does not pop the pause menu.
    const input = Game.input;
    if (input) {
      this._wasPointerLocked = !!input.pointerLocked;
      try { input.exitPointerLock(); } catch { /* optional */ }
      try { input.setEnabled(false); } catch { /* optional */ }
    }

    const overlay = el('div', 'screen-overlay blur');
    const screen = el('div', 'screen', overlay);
    this.overlay = overlay;
    this.screenEl = screen;

    let built = null;
    try {
      const builder = BUILDERS[name] || BUILDERS._unknown;
      built = builder.call(this, screen, this.ctx) || {};
    } catch (err) {
      console.error('[screens] failed to build "' + name + '"', err);
      while (screen.firstChild) screen.removeChild(screen.firstChild);
      el('div', 'screen-title', screen, prettyName(name));
      el('div', 'mc-hint', screen, 'This screen could not be opened.');
      built = {};
    }
    this.hooks.refresh = built.refresh || null;
    this.hooks.tick = built.tick || null;
    this.hooks.frame = built.frame || null;
    this.hooks.dispose = built.dispose || null;

    // Close button, always present.
    const close = el('div', 'screen-close', screen, '✖');
    close.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    close.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); click(); this.close(); });

    overlay.addEventListener('mousedown', (e) => this._onMouseDown(e));
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    overlay.addEventListener('wheel', (e) => {
      // Let real scrollers scroll; otherwise swallow so the hotbar stays put.
      let n = e.target;
      for (let i = 0; i < 6 && n && n !== overlay; i++) {
        if (n.classList && (n.classList.contains('mc-scroll') || n.classList.contains('recipe-results')
          || n.classList.contains('trade-list') || n.classList.contains('creative-grid-scroll'))) return;
        n = n.parentElement;
      }
      e.preventDefault();
    }, { passive: false });

    this.root.appendChild(overlay);

    this.heldEl = el('div', 'held-stack', this.root);
    this.tooltipEl = el('div', 'mc-tooltip', overlay);
    this.tooltipEl.style.display = 'none';

    window.addEventListener('keydown', this._keyHandler, true);
    window.addEventListener('mousemove', this._moveHandler, true);
    window.addEventListener('mouseup', this._upHandler, true);

    this.refresh();
    try { Game.emit('openscreen', name); } catch { /* bus is optional */ }
    return true;
  }

  /** Unmounts the current screen and restores gameplay input. */
  close(silent = false) {
    if (!this.current) return;
    const name = this.current;

    try { if (this.hooks.dispose) this.hooks.dispose(); } catch (err) { console.error('[screens] dispose', err); }
    for (const fn of this._cleanups) {
      try { fn(); } catch (err) { console.error('[screens] cleanup', err); }
    }
    this._cleanups = [];

    // Anything parked in a scratch inventory (crafting grids, anvil inputs)
    // goes back to the player rather than evaporating.
    const player = playerOf(this.ctx);
    for (const inv of this.temps) {
      if (!inv) continue;
      for (let i = 0; i < inv.size; i++) {
        const s = inv.get(i);
        if (!s) continue;
        inv.set(i, null);
        this._returnToPlayer(player, s);
      }
    }
    if (this.held) {
      const s = this.held;
      this.setHeld(null);
      this._returnToPlayer(player, s);
    }

    window.removeEventListener('keydown', this._keyHandler, true);
    window.removeEventListener('mousemove', this._moveHandler, true);
    window.removeEventListener('mouseup', this._upHandler, true);

    if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    if (this.heldEl && this.heldEl.parentNode) this.heldEl.parentNode.removeChild(this.heldEl);
    this.overlay = null;
    this.screenEl = null;
    this.heldEl = null;
    this.tooltipEl = null;
    this.hoverSlot = null;
    this.slots = [];
    this.watched = [];
    this.temps = [];
    this._drag = null;
    this.current = null;
    this.ctx = null;
    this.hooks = { refresh: null, tick: null, frame: null, dispose: null };

    const input = Game.input;
    if (input) {
      try { input.setEnabled(true); } catch { /* optional */ }
      if (!silent && this._wasPointerLocked) {
        try { input.requestPointerLock(); } catch { /* optional */ }
      }
    }
    try { Game.emit('closescreen', name); } catch { /* bus is optional */ }
  }

  /** Puts a stack back in the player's hands, or on the floor. */
  _returnToPlayer(player, s) {
    if (isEmpty(s)) return;
    if (!player) return;
    let left = s;
    try {
      if (typeof player.giveItem === 'function') left = player.giveItem(s);
      else if (player.inventory) left = player.inventory.add(s);
    } catch { left = s; }
    if (!isEmpty(left)) {
      try { if (typeof player.dropItem === 'function') player.dropItem(left, true); } catch { /* gone */ }
    }
  }

  // =========================================================================
  // Per-frame
  // =========================================================================

  /** Called every frame by main.js. */
  update(dt) {
    if (!this.current) return;

    // Any inventory that changed underneath us (hoppers, furnaces, other
    // players) redraws without the screen having to poll every slot.
    let dirty = false;
    for (const w of this.watched) {
      if (!w.inv) continue;
      if (w.inv.version !== w.version) { w.version = w.inv.version; dirty = true; }
    }

    this._accum += dt * 1000;
    let ticks = 0;
    while (this._accum >= TICK_MS && ticks < 5) {
      this._accum -= TICK_MS;
      ticks++;
      if (this.hooks.tick) {
        try { if (this.hooks.tick()) dirty = true; } catch (err) { console.error('[screens] tick', err); }
      }
    }
    if (this._accum > TICK_MS * 10) this._accum = 0;

    if (this.hooks.frame) {
      try { this.hooks.frame(dt); } catch (err) { console.error('[screens] frame', err); }
    }
    if (dirty) this.refresh();
  }

  /** Redraws every slot plus the screen's own widgets. */
  refresh() {
    if (!this.current) return;
    for (const s of this.slots) s.render();
    if (this.hooks.refresh) {
      try { this.hooks.refresh(); } catch (err) { console.error('[screens] refresh', err); }
    }
    this._renderHeld();
  }

  // =========================================================================
  // Slot registration (used by the builders)
  // =========================================================================

  /** Registers a slot and returns it. */
  addSlot(cfg) {
    const s = new Slot(cfg);
    this.slots.push(s);
    if (s.inv) this.watch(s.inv);
    return s;
  }

  /** Starts polling an inventory's version so external writes redraw. */
  watch(inv) {
    if (!inv) return inv;
    for (const w of this.watched) if (w.inv === inv) return inv;
    this.watched.push({ inv, version: inv.version });
    return inv;
  }

  /** Runs `fn` when the screen closes (used to unhook inventory listeners). */
  onClose(fn) { if (typeof fn === 'function') this._cleanups.push(fn); }

  /** Registers a scratch inventory whose contents return to the player on close. */
  temp(size, name) {
    const inv = new Inventory(size, name || '');
    this.temps.push(inv);
    this.watch(inv);
    return inv;
  }

  // =========================================================================
  // Cursor stack
  // =========================================================================

  /** Sets the stack that follows the cursor (mirrored onto the player). */
  setHeld(s) {
    this.held = isEmpty(s) ? null : s;
    const player = playerOf(this.ctx);
    if (player && player.inventory) player.inventory.cursor = this.held;
    this._renderHeld();
  }

  _renderHeld() {
    if (!this.heldEl) return;
    while (this.heldEl.firstChild) this.heldEl.removeChild(this.heldEl.firstChild);
    if (!this.held) { this.heldEl.style.display = 'none'; return; }
    this.heldEl.style.display = '';
    this.heldEl.style.left = this.mouseX + 'px';
    this.heldEl.style.top = this.mouseY + 'px';
    try { this.heldEl.appendChild(stackElement(this.held, 32)); } catch { /* icon unavailable */ }
  }

  // =========================================================================
  // Mouse
  // =========================================================================

  _slotFromEvent(e) {
    let n = e.target;
    for (let i = 0; i < 6 && n && n !== this.overlay; i++) {
      if (n.__slot) return n.__slot;
      n = n.parentElement;
    }
    return null;
  }

  _onMouseMove(e) {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    if (this.heldEl && this.held) {
      this.heldEl.style.left = this.mouseX + 'px';
      this.heldEl.style.top = this.mouseY + 'px';
    }
    const slot = this._slotFromEvent(e);
    if (this._drag && slot && this._drag.slots.indexOf(slot) < 0 && slot.canPlace(this._drag.stack)) {
      this._drag.slots.push(slot);
      slot.el.classList.add('highlight');
    }
    if (slot !== this.hoverSlot) {
      this.hoverSlot = slot;
      this._updateTooltip();
    } else if (this.tooltipEl && this.tooltipEl.style.display !== 'none') {
      this._positionTooltip();
    }
  }

  _onMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    const slot = this._slotFromEvent(e);

    if (!slot) {
      // Text fields, buttons and scrollers keep their native behaviour.
      if (isInteractive(e.target)) return;
      e.preventDefault();
      // Clicking the void throws the cursor stack into the world.
      const onScreen = this.screenEl && this.screenEl.contains(e.target);
      if (!onScreen && this.held) this._throwHeld(e.button === 0);
      return;
    }
    e.preventDefault();
    if (e.shiftKey && e.button === 0) {
      this._quickMove(slot);
      this.refresh();
      return;
    }
    if (!this.held) {
      this._pickUp(slot, e.button === 2);
      this.refresh();
      return;
    }
    // With a stack on the cursor a press starts a potential drag-spread.
    this._drag = { button: e.button, slots: [slot], stack: copyStack(this.held), acted: false };
    slot.el.classList.add('highlight');
  }

  _onMouseUp(e) {
    if (!this.current) return;
    const drag = this._drag;
    if (!drag) return;
    this._drag = null;
    for (const s of drag.slots) s.el.classList.remove('highlight');
    if (e.button !== drag.button) return;

    if (drag.slots.length > 1) {
      this._spread(drag.slots, drag.button === 0);
    } else {
      const slot = drag.slots[0];
      const over = this._slotFromEvent(e);
      if (over === slot || over === null) this._place(slot, drag.button === 2);
      else if (over) this._place(over, drag.button === 2);
    }
    this.refresh();
  }

  /** Ejects the cursor stack (whole stack, or one item on a right click). */
  _throwHeld(all) {
    const player = playerOf(this.ctx);
    if (!this.held || !player) return;
    let out;
    if (all || this.held.count <= 1) {
      out = this.held;
      this.setHeld(null);
    } else {
      out = copyStack(this.held);
      out.count = 1;
      this.held.count -= 1;
      this.setHeld(this.held);
    }
    try {
      if (typeof player.dropItem === 'function') player.dropItem(out, true);
      else this._returnToPlayer(player, out);
    } catch { this._returnToPlayer(player, out); }
    sound('item_pickup', 0.2, 0.8);
  }

  // ---- individual click actions -------------------------------------------

  _pickUp(slot, half) {
    if (!slot.canTake()) return;
    const cur = slot.get();
    if (!cur) return;

    if (slot.takeOnly) { this._takeResult(slot, false); return; }

    const total = cur.count | 0;
    const want = half ? Math.ceil(total / 2) : total;
    const cap = slot.maxTake > 0 ? Math.min(want, slot.maxTake) : want;
    let taken = null;
    try {
      taken = slot.inv && !slot.setFn ? slot.inv.remove(slot.index, cap) : null;
    } catch { taken = null; }
    if (!taken) {
      taken = copyStack(cur);
      taken.count = cap;
      const left = copyStack(cur);
      left.count = total - cap;
      slot.set(left.count > 0 ? left : null);
    } else if (slot.onChanged) {
      slot.onChanged();
    }
    if (taken) {
      this.setHeld(taken);
      // Remember the slot so an immediate second left click gathers.
      this._lastClick = half ? { time: 0, item: null, slot: null }
        : { time: performance.now(), item: taken.item, slot };
    }
  }

  _place(slot, single) {
    const held = this.held;
    if (!held) return;

    if (slot.takeOnly) { this._takeResult(slot, false); return; }
    if (!slot.canPlace(held)) {
      // Clicking a take-only/incompatible slot with a full cursor does nothing,
      // except that a matching result slot still merges into the cursor.
      return;
    }
    const cur = slot.get();
    const cap = slot.capacity(held);

    // Double left click on the same slot sweeps up every matching item.
    const now = performance.now();
    if (!single && this._lastClick.slot === slot && now - this._lastClick.time < 320
      && this._lastClick.item === held.item && (held.count | 0) < maxOf(held)) {
      this._gather(held);
      this._lastClick = { time: 0, item: null, slot: null };
      return;
    }
    this._lastClick = single ? { time: 0, item: null, slot: null }
      : { time: now, item: held.item, slot };

    if (!cur) {
      const put = single ? 1 : Math.min(held.count | 0, cap);
      const drop = copyStack(held);
      drop.count = put;
      slot.set(drop);
      held.count -= put;
      this.setHeld(held.count > 0 ? held : null);
      sound('click', 0.2, 0.9);
      return;
    }
    if (sameItem(cur, held)) {
      const room = Math.max(0, cap - (cur.count | 0));
      if (room <= 0) return;
      const put = single ? Math.min(1, room) : Math.min(held.count | 0, room);
      cur.count += put;
      slot.set(cur);
      held.count -= put;
      this.setHeld(held.count > 0 ? held : null);
      return;
    }
    // Swap, but only when the whole cursor stack fits.
    if (!single && (held.count | 0) <= cap && slot.canTake()) {
      slot.set(held);
      this.setHeld(cur);
    }
  }

  /** Pulls a crafted/smelted/anvil result out. */
  _takeResult(slot, all) {
    const out = slot.get();
    if (!out || !slot.canTake()) return;
    const held = this.held;
    if (held && (!sameItem(held, out) || (held.count | 0) + (out.count | 0) > maxOf(held))) return;

    let crafted = 0;
    const once = () => {
      const s = slot.get();
      if (!s) return false;
      const copy = copyStack(s);
      if (this.held && sameItem(this.held, copy)) {
        if ((this.held.count | 0) + (copy.count | 0) > maxOf(copy)) return false;
        this.held.count += copy.count | 0;
        this.setHeld(this.held);
      } else if (!this.held) {
        this.setHeld(copy);
      } else {
        return false;
      }
      slot.set(null);
      if (slot.onTaken) {
        try { slot.onTaken(copy); } catch (err) { console.error('[screens] onTaken', err); }
      }
      crafted++;
      return true;
    };
    if (all) {
      for (let i = 0; i < 64 && once(); i++) { /* craft until it stops */ }
    } else {
      once();
    }
    if (crafted) sound('craft', 0.4, 1);
  }

  /**
   * Shift-clicking a result slot: repeats the craft, sending every batch
   * straight into the player's inventory until something runs out.
   */
  _craftAll(slot) {
    const player = playerOf(this.ctx);
    const inv = player && player.inventory;
    if (!inv) { this._takeResult(slot, true); return; }
    let made = 0;
    for (let i = 0; i < 64; i++) {
      const s = slot.get();
      if (!s || !slot.canTake()) break;
      const copy = copyStack(s);
      const over = inv.add(copyStack(copy));
      if (over && (over.count | 0) >= (copy.count | 0)) break;   // no room at all
      slot.set(null);
      if (slot.onTaken) {
        try { slot.onTaken(copy); } catch (err) { console.error('[screens] onTaken', err); }
      }
      made++;
      if (over) { this._returnToPlayer(player, over); break; }
    }
    if (made) sound('craft', 0.45, 1);
  }

  /** Sweeps every matching item in the screen into the cursor stack. */
  _gather(held) {
    const cap = maxOf(held);
    for (const slot of this.slots) {
      if (held.count >= cap) break;
      if (slot.takeOnly || slot.readOnly || !slot.canTake()) continue;
      const s = slot.get();
      if (!s || !sameItem(s, held)) continue;
      const take = Math.min(s.count | 0, cap - held.count);
      if (take <= 0) continue;
      held.count += take;
      if ((s.count | 0) - take <= 0) slot.set(null);
      else { s.count -= take; slot.set(s); }
    }
    this.setHeld(held);
  }

  /** Distributes the cursor stack over the slots the drag touched. */
  _spread(slots, even) {
    const held = this.held;
    if (!held) return;
    const targets = slots.filter((s) => s.canPlace(held));
    if (!targets.length) return;
    const total = held.count | 0;
    const per = even ? Math.max(1, Math.floor(total / targets.length)) : 1;
    let left = total;
    for (const slot of targets) {
      if (left <= 0) break;
      const cur = slot.get();
      const cap = slot.capacity(held);
      if (cur && !sameItem(cur, held)) continue;
      const have = cur ? (cur.count | 0) : 0;
      const put = Math.min(per, cap - have, left);
      if (put <= 0) continue;
      if (cur) { cur.count = have + put; slot.set(cur); } else {
        const drop = copyStack(held);
        drop.count = put;
        slot.set(drop);
      }
      left -= put;
    }
    held.count = left;
    this.setHeld(left > 0 ? held : null);
    sound('click', 0.25, 1.1);
  }

  /** Shift-click routing. */
  _quickMove(slot) {
    if (!slot.canTake()) return;
    if (slot.quick) {
      try { if (slot.quick(slot)) return; } catch (err) { console.error('[screens] quick', err); }
    }
    if (slot.takeOnly) { this._craftAll(slot); return; }
    const s = slot.get();
    if (!s) return;
    // Nothing declared a destination: fall back to the player's own rows.
    const player = playerOf(this.ctx);
    const inv = player && player.inventory;
    if (!inv || slot.inv === inv) {
      if (inv && slot.inv === inv) this._playerInternalMove(slot, inv);
      return;
    }
    this.moveToPlayer(slot.inv, slot.index, inv);
  }

  /** Hotbar <-> backpack shuffling inside the player's own inventory. */
  _playerInternalMove(slot, inv) {
    const s = slot.get();
    if (!s) return;
    const i = slot.index;
    // Armour and offhand always come back to the main rows.
    if (i >= ARMOR_SLOT_START) {
      transferStack(inv, i, inv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
      if (inv.get(i)) transferStack(inv, i, inv, null, [0, HOTBAR_SIZE]);
      return;
    }
    // Wearable things go straight onto the body.
    const def = getItem(s.item);
    if (def && def.armor && def.armor.index >= 0 && def.armor.index < ARMOR_SLOTS) {
      const target = ARMOR_SLOT_START + def.armor.index;
      if (!inv.get(target) && inv.canAccept(target, s)) {
        inv.set(target, s);
        inv.set(i, null);
        sound('armor_equip', 0.5, 1);
        return;
      }
    }
    if (i < HOTBAR_SIZE) transferStack(inv, i, inv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    else transferStack(inv, i, inv, null, [0, HOTBAR_SIZE]);
  }

  /**
   * Moves a stack into the player's 36 main slots, backpack first exactly like
   * vanilla. Returns how many items landed.
   */
  moveToPlayer(from, index, inv) {
    if (!from || !inv) return 0;
    let moved = transferStack(from, index, inv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    if (from.get(index)) moved += transferStack(from, index, inv, null, [0, HOTBAR_SIZE]);
    return moved;
  }

  /** Moves a stack from the player into a container. */
  moveToContainer(inv, index, target, range) {
    if (!inv || !target) return 0;
    return transferStack(inv, index, target, null, range || null);
  }

  // =========================================================================
  // Tooltip
  // =========================================================================

  _updateTooltip() {
    const tip = this.tooltipEl;
    if (!tip) return;
    const slot = this.hoverSlot;
    const s = slot ? slot.get() : null;
    const custom = slot && slot.tooltip ? slot.tooltip : null;
    if (!s && !custom) { tip.style.display = 'none'; return; }

    let lines;
    if (custom) lines = custom;
    else {
      try { lines = stackTooltipLines(s); } catch { lines = [{ text: stackDisplayName(s), color: null }]; }
    }
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    tip.className = 'mc-tooltip rarity-' + (s ? stackRarity(s) : 'common');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const e = el('div', i === 0 ? 'mc-tooltip-title' : 'mc-tooltip-line', tip, l.text || ' ');
      if (l.color && i > 0) e.style.color = l.color;
      if (l.italic) e.style.fontStyle = 'italic';
    }
    tip.style.display = '';
    this._positionTooltip();
  }

  _positionTooltip() {
    const tip = this.tooltipEl;
    if (!tip || !this.overlay) return;
    const box = this.overlay.getBoundingClientRect();
    let x = this.mouseX - box.left + 12;
    let y = this.mouseY - box.top - 8;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > box.width - 4) x = Math.max(4, this.mouseX - box.left - w - 12);
    if (y + h > box.height - 4) y = Math.max(4, box.height - h - 4);
    if (y < 4) y = 4;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  // =========================================================================
  // Keyboard
  // =========================================================================

  _onKey(e) {
    if (!this.current) return;
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (typing && target.blur) { target.blur(); return; }
      this.close();
      return;
    }
    if (typing) return;

    const invKey = this._keyFor('inventory') || 'KeyE';
    if (e.code === invKey && this.current !== 'sign' && this.current !== 'book') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.code === (this._keyFor('drop') || 'KeyQ')) {
      if (this.held) { e.preventDefault(); this._throwHeld(e.ctrlKey); this.refresh(); return; }
      if (this.hoverSlot && this.hoverSlot.canTake()) {
        const s = this.hoverSlot.get();
        if (s) {
          e.preventDefault();
          const player = playerOf(this.ctx);
          let out;
          if (e.ctrlKey || (s.count | 0) <= 1) { out = s; this.hoverSlot.set(null); } else {
            out = copyStack(s); out.count = 1; s.count -= 1; this.hoverSlot.set(s);
          }
          try { if (player && player.dropItem) player.dropItem(out, true); } catch { /* gone */ }
          this.refresh();
        }
      }
      return;
    }
    // 1..9 swap the hovered slot with that hotbar slot.
    if (/^Digit[1-9]$/.test(e.code)) {
      const n = Number(e.code.slice(5)) - 1;
      this._hotbarSwap(n);
      e.preventDefault();
    }
  }

  _keyFor(action) {
    const st = Game.settings;
    try {
      if (st && typeof st.get === 'function') {
        const binds = st.get('keybinds');
        if (binds && binds[action]) return binds[action];
      }
    } catch { /* settings are optional */ }
    return null;
  }

  _hotbarSwap(n) {
    const slot = this.hoverSlot;
    const player = playerOf(this.ctx);
    const inv = player && player.inventory;
    if (!slot || !inv || n < 0 || n >= HOTBAR_SIZE) return;
    if (slot.readOnly) return;

    const hot = inv.get(n);
    const cur = slot.get();
    if (slot.takeOnly) {
      if (!cur) return;
      if (hot) return;
      const copy = copyStack(cur);
      slot.set(null);
      inv.set(n, copy);
      if (slot.onTaken) { try { slot.onTaken(copy); } catch { /* ignore */ } }
      this.refresh();
      return;
    }
    if (hot && !slot.canPlace(hot)) return;
    slot.set(hot);
    inv.set(n, cur);
    this.refresh();
  }

  // =========================================================================
  // Shared layout pieces
  // =========================================================================

  /**
   * The player's 3x9 backpack plus the hotbar row. `target` is the container
   * shift-clicks push into (null = shuffle inside the player's own rows).
   */
  buildPlayerRows(parent, player, target, range) {
    const inv = player && player.inventory;
    if (!inv) return null;
    const wrap = el('div', 'mc-col', parent);
    const quick = target ? (slot) => {
      this.moveToContainer(inv, slot.index, target, range);
      return true;
    } : null;

    const grid = el('div', 'inventory-grid', wrap);
    for (let i = HOTBAR_SIZE; i < INV_MAIN_SIZE; i++) {
      this.addSlot({ inv, index: i, parent: grid, quick, group: 'player' });
    }
    const hot = el('div', 'hotbar-grid', wrap);
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this.addSlot({ inv, index: i, parent: hot, quick, group: 'player' });
    }
    return wrap;
  }

  /** Armour column + offhand slot, as used by the inventory screens. */
  buildArmorSlots(parent, player) {
    const inv = player && player.inventory;
    if (!inv) return null;
    const col = el('div', 'armor-slots', parent);
    for (let i = 0; i < ARMOR_SLOTS; i++) {
      this.addSlot({
        inv,
        index: ARMOR_SLOT_START + i,
        parent: col,
        className: 'armor-slot',
        group: 'armor',
      });
    }
    return col;
  }

  /** A live paper-doll of the player drawn from the procedural skin canvas. */
  buildPlayerPreview(parent, player) {
    const box = el('div', 'player-preview', parent);
    const canvas = el('canvas', 'pixel', box);
    const S = 6;
    canvas.width = 24 * S;
    canvas.height = 32 * S;
    let skin = null;
    try { skin = getSkin((player && player.skin) || 'player'); } catch { skin = null; }
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;

    const draw = () => {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      // Soft floor shadow so the doll does not float.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(5 * S, 31 * S, 14 * S, S);
      if (!skin) return;
      const box2 = box.getBoundingClientRect();
      const cx = box2.left + box2.width / 2;
      const cy = box2.top + box2.height / 2;
      const lean = clamp((this.mouseX - cx) / 220, -1, 1);
      const nod = clamp((this.mouseY - cy) / 260, -1, 1);
      const ox = 4;
      const blit = (sx, sy, sw, sh, dx, dy) => {
        try { ctx.drawImage(skin, sx, sy, sw, sh, (dx + ox) * S, dy * S, sw * S, sh * S); } catch { /* skip */ }
      };
      // legs, arms, body, then the head (which tracks the cursor slightly)
      blit(4, 20, 4, 12, 4, 20);       // right leg
      blit(20, 52, 4, 12, 8, 20);      // left leg
      blit(20, 20, 8, 12, 4, 8);       // body
      blit(20, 36, 8, 12, 4, 8);       // jacket overlay
      blit(44, 20, 4, 12, 0, 8);       // right arm
      blit(44, 36, 4, 12, 0, 8);
      blit(36, 52, 4, 12, 12, 8);      // left arm
      blit(52, 52, 4, 12, 12, 8);
      const hx = 4 + lean * 1.2;
      const hy = nod * 0.8;
      blit(8, 8, 8, 8, hx, hy);        // head front
      blit(40, 8, 8, 8, hx, hy);       // hat overlay
    };
    draw();
    return { el: box, draw };
  }
}

// ===========================================================================
// Screen builders
//
// Each builder runs with `this` bound to the Screens instance, receives the
// `.screen` element and the open() context, and returns optional hooks:
//   { refresh(), tick() -> boolean, frame(dt), dispose() }
// ===========================================================================

const BUILDERS = {};

/** Adds the standard `.screen-title` line. */
function title(parent, text) {
  return el('div', 'screen-title', parent, text);
}

/** `.screen-body` wrapper every screen puts its guts in. */
function body(parent, cls) {
  return el('div', 'screen-body' + (cls ? ' ' + cls : ''), parent);
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------
BUILDERS._unknown = function unknownScreen(screen, ctx) {
  title(screen, prettyName(this.current || 'screen'));
  const b = body(screen);
  el('div', 'mc-hint', b, 'Nothing to see here yet.');
  const player = playerOf(ctx);
  if (player) this.buildPlayerRows(b, player, null);
  return {};
};

// ---------------------------------------------------------------------------
// Crafting core, shared by the inventory (2x2) and crafting table (3x3)
// ---------------------------------------------------------------------------

/**
 * Wires a crafting grid to a result slot with live recipe matching.
 * Returns { grid, result, recompute, gridSlots }.
 */
function makeCrafting(screens, gridParent, resultParent, size, player) {
  const n = size * size;
  const grid = player && player.inventory && size === 2 && player.inventory.crafting
    ? screens.watch(player.inventory.crafting)
    : screens.temp(n, 'crafting');
  if (grid.size < n) grid.size = n;
  if (size === 2 && grid !== null && screens.temps.indexOf(grid) < 0) screens.temps.push(grid);

  const resultInv = new Inventory(1, 'crafting_result');
  screens.watch(resultInv);

  const cells = [];
  for (let i = 0; i < n; i++) {
    cells.push(screens.addSlot({ inv: grid, index: i, parent: gridParent, group: 'craft' }));
  }

  const recompute = () => {
    const cellsArr = new Array(n);
    for (let i = 0; i < n; i++) cellsArr[i] = grid.get(i);
    let out = null;
    try { out = matchRecipe(cellsArr, size, size); } catch { out = null; }
    resultInv.slots[0] = out || null;
    resultInv.markChanged(0);
  };

  const consume = () => {
    const cellsArr = new Array(n);
    for (let i = 0; i < n; i++) cellsArr[i] = grid.get(i);
    let remains = null;
    try { remains = remainingItems(cellsArr); } catch { remains = null; }
    for (let i = 0; i < n; i++) {
      const s = grid.get(i);
      if (!s) continue;
      const left = remains && remains[i];
      if ((s.count | 0) <= 1) {
        if (left) grid.set(i, copyStack(left));
        else grid.set(i, null);
      } else {
        s.count -= 1;
        grid.set(i, s);
        if (left) {
          const inv = player && player.inventory;
          let over = left;
          if (inv) over = inv.add(copyStack(left));
          if (over && player && player.dropItem) { try { player.dropItem(over, true); } catch { /* gone */ } }
        }
      }
    }
    recompute();
  };

  const result = screens.addSlot({
    inv: resultInv,
    index: 0,
    parent: resultParent,
    className: 'result',
    takeOnly: true,
    onTaken: (outStack) => {
      consume();
      try { Game.emit('craft', outStack); } catch { /* bus optional */ }
      if (player && typeof player.addExhaustion === 'function') {
        try { player.addExhaustion(0.005); } catch { /* optional */ }
      }
    },
    group: 'result',
  });

  // Any write to the grid - a slot click, a shift-click, the recipe book -
  // re-runs the matcher, so the result slot is never stale.
  const prevOnChange = grid.onChange;
  grid.onChange = (i, st, inv2) => {
    if (prevOnChange) { try { prevOnChange(i, st, inv2); } catch (err) { console.error('[screens] grid', err); } }
    recompute();
  };
  screens.onClose(() => { grid.onChange = prevOnChange; });

  for (const c of cells) {
    c.quick = (slot) => {
      const inv = player && player.inventory;
      if (!inv) return false;
      screens.moveToPlayer(grid, slot.index, inv);
      recompute();
      return true;
    };
  }
  recompute();
  return { grid, gridSlots: cells, result, recompute, resultInv, consume };
}

/** Item names an ingredient (name, '#tag' or list) can be satisfied by. */
function ingredientNames(ing) {
  if (typeof ing === 'string') {
    if (ing.charCodeAt(0) === 35) return TAGS[ing] || [];
    return [ing];
  }
  if (Array.isArray(ing)) {
    const out = [];
    for (const i of ing) out.push(...ingredientNames(i));
    return out;
  }
  if (ing && typeof ing === 'object' && ing.item) return [ing.item];
  return [];
}

/**
 * Empties a crafting grid back into the player and refills it from a recipe.
 * @returns {boolean} true when the grid was filled
 */
function fillGridFromRecipe(screens, recipe, grid, size, player) {
  const inv = player && player.inventory;
  if (!recipe || !inv) return false;
  const n = size * size;
  for (let i = 0; i < n; i++) {
    const s = grid.get(i);
    if (!s) continue;
    grid.set(i, null);
    const over = inv.add(s);
    if (over) screens._returnToPlayer(player, over);
  }
  const creative = isCreative(player);
  const take = (ing) => {
    const names = ingredientNames(ing);
    for (const name of names) {
      if (creative) return mkStack(name, 1);
      if (inv.count(name) > 0) { inv.removeItem(name, 1); return mkStack(name, 1); }
    }
    return null;
  };

  if (recipe.type === 'shaped' && Array.isArray(recipe.cells)) {
    if (recipe.w > size || recipe.h > size) return false;
    for (let y = 0; y < recipe.h; y++) {
      for (let x = 0; x < recipe.w; x++) {
        const ing = recipe.cells[y * recipe.w + x];
        if (!ing) continue;
        const s = take(ing);
        if (s) grid.set(y * size + x, s);
      }
    }
    return true;
  }
  const list = recipe.ingredients || [];
  if (list.length > n) return false;
  for (let i = 0; i < list.length; i++) {
    const s = take(list[i]);
    if (s) grid.set(i, s);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Recipe book panel
// ---------------------------------------------------------------------------

const RECIPE_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'building', label: 'Blocks', groups: ['building', 'decoration', 'colored_blocks', 'building_blocks', 'natural', 'functional'] },
  { id: 'redstone', label: 'Redstone', groups: ['redstone', 'transport'] },
  { id: 'equipment', label: 'Gear', groups: ['combat', 'tools', 'equipment'] },
  { id: 'misc', label: 'Misc', groups: ['misc', 'food', 'brewing', 'ingredients'] },
];

/**
 * The recipe book: search field, category filter and a grid of results that
 * auto-fill the crafting grid when clicked.
 */
function buildRecipeBook(screens, parent, player, crafting, size) {
  const panel = el('div', 'recipe-book', parent);
  const search = el('input', 'mc-input recipe-search', panel);
  search.type = 'text';
  search.placeholder = 'Search…';
  search.spellcheck = false;

  const tabs = el('div', 'mc-row', panel);
  let category = 'all';
  let showAll = false;
  const catButtons = [];
  for (const c of RECIPE_CATEGORIES) {
    const b = el('button', 'mc-button small' + (c.id === category ? ' active' : ''), tabs, c.label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      click();
      category = c.id;
      for (const x of catButtons) x.el.classList.toggle('active', x.id === category);
      rebuild();
    });
    catButtons.push({ id: c.id, el: b });
  }
  const results = el('div', 'recipe-results', panel);
  const footer = el('div', 'mc-row', panel);
  const toggle = el('button', 'mc-button small', footer, 'Craftable');
  toggle.type = 'button';
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    click();
    showAll = !showAll;
    toggle.textContent = showAll ? 'All Recipes' : 'Craftable';
    toggle.classList.toggle('active', showAll);
    rebuild();
  });
  const countLabel = el('span', 'mc-hint', footer, '');

  const inCategory = (r) => {
    if (category === 'all') return true;
    const c = RECIPE_CATEGORIES.find((x) => x.id === category);
    if (!c || !c.groups) return true;
    const g = r.group || (ITEMS[r.output.item] && ITEMS[r.output.item].group) || 'misc';
    const tab = ITEMS[r.output.item] && ITEMS[r.output.item].tab;
    return c.groups.indexOf(g) >= 0 || (tab && c.groups.indexOf(tab) >= 0);
  };

  const rebuild = () => {
    while (results.firstChild) results.removeChild(results.firstChild);
    const inv = player && player.inventory;
    let craftable = [];
    try { craftable = inv ? craftableFrom(inv, size) : []; } catch { craftable = []; }
    const craftableSet = new Set(craftable);
    const query = search.value.trim().toLowerCase();

    let pool = showAll ? RECIPES : craftable;
    const out = [];
    for (const r of pool) {
      if (!r || !r.output || r.type === 'smithing') continue;
      if (r.maxDim > size) continue;
      if (!inCategory(r)) continue;
      if (query) {
        const def = ITEMS[r.output.item];
        const label = (def && def.display ? def.display : prettyName(r.output.item)).toLowerCase();
        if (label.indexOf(query) < 0 && r.output.item.indexOf(query) < 0) continue;
      }
      out.push(r);
      if (out.length >= 240) break;
    }
    countLabel.textContent = out.length + (out.length === 240 ? '+' : '') + ' recipes';

    for (const r of out) {
      const canMake = craftableSet.has(r);
      const entry = el('div', 'recipe-entry' + (canMake ? '' : ' locked'), results);
      setIcon(el('img', '', entry), r.output.item);
      entry.__slot = {
        get: () => ({ item: r.output.item, count: r.output.count || 1 }),
        canTake: () => false,
        canPlace: () => false,
        set: () => {},
        render: () => {},
        readOnly: true,
        takeOnly: false,
        el: entry,
      };
      entry.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!canMake) { sound('click', 0.3, 0.7); return; }
        click();
        if (fillGridFromRecipe(screens, r, crafting.grid, size, player)) {
          crafting.recompute();
          screens.refresh();
        }
      });
    }
  };

  search.addEventListener('input', rebuild);
  search.addEventListener('keydown', (e) => e.stopPropagation());
  rebuild();

  // Rebuilding is DOM-heavy, so only do it when the inventory actually moved.
  let lastVersion = player && player.inventory ? player.inventory.version : -1;
  const maybeRebuild = () => {
    const v = player && player.inventory ? player.inventory.version : -1;
    if (v === lastVersion) return false;
    lastVersion = v;
    rebuild();
    return true;
  };
  return { el: panel, rebuild, maybeRebuild };
}

// ---------------------------------------------------------------------------
// inventory (2x2 crafting, armour, offhand, paper doll)
// ---------------------------------------------------------------------------
BUILDERS.inventory = function inventoryScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Crafting');
  const b = body(screen);
  const top = el('div', 'mc-row', b);
  top.style.gap = 'var(--u6)';
  top.style.alignItems = 'flex-start';

  this.buildArmorSlots(top, player);
  const preview = this.buildPlayerPreview(top, player);

  const offCol = el('div', 'mc-col', top);
  this.addSlot({
    inv: player && player.inventory,
    index: OFFHAND_SLOT,
    parent: offCol,
    className: 'offhand-slot',
    group: 'armor',
  });

  el('div', 'mc-spacer', top);

  const craftBox = el('div', 'mc-row', top);
  craftBox.style.alignItems = 'center';
  craftBox.style.gap = 'var(--u4)';
  const gridEl = el('div', 'crafting-grid', craftBox);
  gridEl.style.gridTemplateColumns = 'repeat(2, var(--slot))';
  const arrow = el('div', 'crafting-arrow', craftBox);
  const resultBox = el('div', 'mc-col', craftBox);
  const crafting = makeCrafting(this, gridEl, resultBox, 2, player);

  this.buildPlayerRows(b, player, null);

  return {
    refresh: () => {
      arrow.classList.toggle('ready', !!crafting.resultInv.get(0));
    },
    frame: () => { preview.draw(); },
  };
};

// ---------------------------------------------------------------------------
// crafting table (3x3 + recipe book)
// ---------------------------------------------------------------------------
BUILDERS.crafting = function craftingScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Crafting');
  const b = body(screen);
  const row = el('div', 'mc-row', b);
  row.style.gap = 'var(--u6)';
  row.style.alignItems = 'flex-start';

  const left = el('div', 'mc-col', row);
  const craftRow = el('div', 'mc-row', left);
  craftRow.style.alignItems = 'center';
  craftRow.style.gap = 'var(--u4)';
  const gridEl = el('div', 'crafting-grid', craftRow);
  const arrow = el('div', 'crafting-arrow', craftRow);
  const resultBox = el('div', 'mc-col', craftRow);
  const crafting = makeCrafting(this, gridEl, resultBox, 3, player);

  const bookWrap = el('div', 'mc-col', row);
  const book = buildRecipeBook(this, bookWrap, player, crafting, 3);

  this.buildPlayerRows(b, player, null);

  let cooldown = 0;
  return {
    refresh: () => {
      arrow.classList.toggle('ready', !!crafting.resultInv.get(0));
    },
    tick: () => {
      // The book only needs to notice inventory changes a few times a second.
      if (++cooldown < 10) return false;
      cooldown = 0;
      book.maybeRebuild();
      return false;
    },
  };
};

// ---------------------------------------------------------------------------
// furnace / blast furnace / smoker
// ---------------------------------------------------------------------------
BUILDERS.furnace = function furnaceScreen(screen, ctx) {
  const player = playerOf(ctx);
  const world = ctx.world || (player && player.world) || Game.world;
  const block = ctx.block || 'furnace';
  const kind = block === 'blast_furnace' || block === 'smoker' ? block : 'furnace';
  const inv = beInventory(world, ctx.x | 0, ctx.y | 0, ctx.z | 0, 3, block);
  const be = inv.be;
  be.kind = kind;
  if (typeof be.burnTime !== 'number') be.burnTime = 0;
  if (typeof be.fuelTime !== 'number') be.fuelTime = 0;
  if (typeof be.cookTime !== 'number') be.cookTime = 0;
  if (typeof be.xp !== 'number') be.xp = 0;
  this.watch(inv);

  title(screen, getItem(block).display || prettyName(block));
  const b = body(screen);
  const layout = el('div', 'furnace-layout', b);

  const inSlot = el('div', 'mc-col', layout);
  inSlot.className = 'furnace-input';
  const flame = el('div', 'furnace-flame', layout);
  const fuelBox = el('div', 'furnace-fuel', layout);
  const arrow = el('div', 'furnace-arrow', layout);
  const outBox = el('div', 'furnace-output', layout);

  const toPlayer = (slot) => {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    this.moveToPlayer(inv, slot.index, pinv);
    return true;
  };

  this.addSlot({ inv, index: 0, parent: inSlot, quick: toPlayer, filter: (s) => !!smeltResult(kind, s.item) });
  this.addSlot({ inv, index: 1, parent: fuelBox, quick: toPlayer, filter: (s) => isFuel(s.item) });
  this.addSlot({
    inv,
    index: 2,
    parent: outBox,
    className: 'result',
    takeOnly: true,
    quick: (slot) => { toPlayer(slot); grantXp(); return true; },
    onTaken: () => grantXp(),
  });

  const grantXp = () => {
    const amount = Math.floor(be.xp || 0);
    if (amount > 0 && player && typeof player.addXP === 'function') {
      try { player.addXP(amount); } catch { /* optional */ }
      be.xp -= amount;
    }
  };

  // Shift-clicking from the player rows routes by what the item is for.
  this.buildPlayerRows(b, player, inv);
  for (const slot of this.slots) {
    if (slot.group !== 'player') continue;
    slot.quick = (s) => {
      const st = s.get();
      if (!st) return true;
      const pinv = player.inventory;
      if (smeltResult(kind, st.item)) this.moveToContainer(pinv, s.index, inv, [0, 1]);
      else if (isFuel(st.item)) this.moveToContainer(pinv, s.index, inv, [1, 2]);
      else this._playerInternalMove(s, pinv);
      return true;
    };
  }

  const total = KIND_TIME[kind] || 200;

  // The world owns the smelting simulation now (blockupdate.js tickFurnaces),
  // so a furnace keeps burning with its screen closed. This screen only draws;
  // ticking here as well would cook everything at double speed while open.
  const tick = () => true;

  return {
    refresh: () => {
      const input = inv.get(0);
      const recipe = input ? smeltResult(kind, input.item) : null;
      const need = recipe ? (recipe.time || total) : total;
      arrow.style.setProperty('--progress', String(clamp((be.cookTime | 0) / Math.max(1, need), 0, 1)));
      const f = be.fuelTime > 0 ? clamp(be.burnTime / be.fuelTime, 0, 1) : 0;
      flame.style.setProperty('--fuel', String(f));
      flame.classList.toggle('lit', be.burnTime > 0);
    },
    tick,
  };
};
BUILDERS.blast_furnace = BUILDERS.furnace;
BUILDERS.smoker = BUILDERS.furnace;

// ---------------------------------------------------------------------------
// chest / barrel / shulker box / ender chest, hopper, dispenser
// ---------------------------------------------------------------------------

/** Shared builder for plain N-slot containers. */
function containerScreen(screens, screen, ctx, size, gridClass) {
  const player = playerOf(ctx);
  const world = ctx.world || (player && player.world) || Game.world;
  let inv = ctx.container || ctx.inventory || null;

  if (!inv) {
    const x = ctx.x | 0, y = ctx.y | 0, z = ctx.z | 0;
    const primary = beInventory(world, x, y, z, size, ctx.block || 'container');
    if (ctx.pair && ctx.pair.x !== undefined) {
      const other = beInventory(world, ctx.pair.x | 0, ctx.pair.y | 0, ctx.pair.z | 0, size, ctx.block || 'container');
      inv = doubleInventory(primary, other, 'Large Chest');
      screens.watch(primary);
      screens.watch(other);
    } else {
      inv = primary;
    }
  }
  screens.watch(inv);

  const label = ctx.title || (inv.name && inv.name !== 'container' ? prettyName(inv.name) : null)
    || (ctx.block ? (getItem(ctx.block).display || prettyName(ctx.block)) : 'Container');
  title(screen, label);
  const b = body(screen);

  const grid = el('div', gridClass || 'chest-grid', b);
  const toPlayer = (slot) => {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    screens.moveToPlayer(inv, slot.index, pinv);
    return true;
  };
  for (let i = 0; i < inv.size; i++) {
    screens.addSlot({ inv, index: i, parent: grid, quick: toPlayer, group: 'container' });
  }
  screens.buildPlayerRows(b, player, inv);
  return {};
}

BUILDERS.chest = function chestScreen(screen, ctx) {
  const name = ctx.block || '';
  let size = ctx.size | 0;
  if (!size) {
    if (name === 'chiseled_bookshelf') size = 6;
    else size = 27;
  }
  return containerScreen(this, screen, ctx, size, 'chest-grid');
};
BUILDERS.barrel = BUILDERS.chest;
BUILDERS.shulker_box = BUILDERS.chest;
BUILDERS.ender_chest = BUILDERS.chest;

BUILDERS.hopper = function hopperScreen(screen, ctx) {
  return containerScreen(this, screen, ctx, ctx.size || 5, 'hopper-grid');
};

BUILDERS.dispenser = function dispenserScreen(screen, ctx) {
  return containerScreen(this, screen, ctx, ctx.size || 9, 'dispenser-grid');
};
BUILDERS.dropper = BUILDERS.dispenser;

// ---------------------------------------------------------------------------
// anvil
// ---------------------------------------------------------------------------
BUILDERS.anvil = function anvilScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Repair & Name');
  const b = body(screen);
  const grid = el('div', 'anvil', b);

  const inputs = this.temp(2, 'anvil');
  const outInv = new Inventory(1, 'anvil_result');
  this.watch(outInv);

  const nameField = el('input', 'mc-input anvil-name-field', grid);
  nameField.type = 'text';
  nameField.maxLength = 50;
  nameField.placeholder = 'Item name';
  nameField.spellcheck = false;

  const leftBox = el('div', '', grid);
  el('div', 'anvil-plus', grid);
  const rightBox = el('div', '', grid);
  el('div', 'crafting-arrow', grid);
  const outBox = el('div', '', grid);
  const costEl = el('div', 'anvil-cost', grid, '');

  let current = null;   // last anvilResult()

  const recompute = () => {
    const left = inputs.get(0);
    const right = inputs.get(1);
    const custom = nameField.value.trim();
    let res = null;
    try { res = left ? anvilResult(left, right, custom || null) : null; } catch { res = null; }
    current = res;
    outInv.slots[0] = res && res.stack ? res.stack : null;
    outInv.markChanged(0);
  };

  inputs.onChange = () => recompute();
  this.addSlot({ inv: inputs, index: 0, parent: leftBox, quick: quickBack });
  this.addSlot({ inv: inputs, index: 1, parent: rightBox, quick: quickBack });

  function quickBack(slot) {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    transferStack(inputs, slot.index, pinv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    if (inputs.get(slot.index)) transferStack(inputs, slot.index, pinv, null, [0, HOTBAR_SIZE]);
    recompute();
    return true;
  }

  const outSlot = this.addSlot({
    inv: outInv,
    index: 0,
    parent: outBox,
    className: 'result',
    takeOnly: true,
    onTaken: () => {
      const res = current;
      if (!res) return;
      const cost = res.cost | 0;
      if (!isCreative(player) && player) {
        player.xpLevel = Math.max(0, (player.xpLevel | 0) - cost);
        player.xpProgress = 0;
      }
      inputs.set(0, null);
      const right = inputs.get(1);
      const used = res.materialCost | 0;
      if (right && used > 0 && (right.count | 0) > used) {
        right.count -= used;
        inputs.set(1, right);
      } else {
        inputs.set(1, null);
      }
      sound('anvil_use', 0.6, 1);
      recompute();
    },
  });

  // A result you cannot afford is unclickable.
  outSlot.canTake = () => {
    if (!current || !current.stack) return false;
    if (isCreative(player)) return true;
    return (player ? player.xpLevel | 0 : 0) >= (current.cost | 0) && (current.cost | 0) < 40;
  };

  nameField.addEventListener('input', () => { recompute(); this.refresh(); });
  nameField.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape') nameField.blur();
  });

  this.buildPlayerRows(b, player, inputs, [0, 2]);
  recompute();

  return {
    refresh: () => {
      const left = inputs.get(0);
      if (left && document.activeElement !== nameField && nameField.dataset.for !== left.item) {
        nameField.dataset.for = left.item;
        nameField.value = left.customName || '';
      }
      if (!left) { nameField.dataset.for = ''; }
      if (!current) { costEl.textContent = ''; costEl.classList.remove('too-expensive'); return; }
      const cost = current.cost | 0;
      const broke = !isCreative(player) && (player ? player.xpLevel | 0 : 0) < cost;
      if (current.tooExpensive || cost >= 40) {
        costEl.textContent = 'Too Expensive!';
        costEl.classList.add('too-expensive');
      } else {
        costEl.textContent = 'Enchantment Cost: ' + cost;
        costEl.classList.toggle('too-expensive', broke);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// enchanting table
// ---------------------------------------------------------------------------
BUILDERS.enchanting = function enchantingScreen(screen, ctx) {
  const player = playerOf(ctx);
  const world = ctx.world || (player && player.world) || Game.world;
  title(screen, 'Enchant');
  const b = body(screen);
  const layout = el('div', 'mc-row', b);
  layout.style.gap = 'var(--u6)';
  layout.style.alignItems = 'flex-start';

  const leftCol = el('div', 'mc-col', layout);
  const bookCanvas = el('canvas', 'pixel', leftCol);
  bookCanvas.width = 96;
  bookCanvas.height = 72;
  bookCanvas.style.width = 'calc(var(--gs) * 32px)';
  bookCanvas.style.height = 'calc(var(--gs) * 24px)';
  const bookCtx = bookCanvas.getContext ? bookCanvas.getContext('2d') : null;

  const slotRow = el('div', 'mc-row', leftCol);
  const inputs = this.temp(2, 'enchant');
  inputs.onChange = (i) => { if (i === 0 || i < 0) reroll(); else refreshOffers(); };
  this.addSlot({ inv: inputs, index: 0, parent: slotRow, quick: back });
  this.addSlot({
    inv: inputs,
    index: 1,
    parent: slotRow,
    filter: (s) => s.item === 'lapis_lazuli',
    quick: back,
  });
  el('div', 'mc-hint', leftCol, 'Lapis Lazuli');

  const table = el('div', 'enchant-table', layout);
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = el('div', 'enchant-offer disabled', table);
    const lapis = el('div', 'enchant-lapis', row, '');
    const runes = el('div', 'enchant-runes', row, '');
    const clue = el('div', 'enchant-hint', row, '');
    const lvl = el('div', 'enchant-level', row, '');
    row.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); pick(i); });
    rows.push({ row, lapis, runes, lvl, clue });
  }
  const hint = el('div', 'mc-hint', table, 'Place an item and lapis lazuli');

  function back(slot) {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    transferStack(inputs, slot.index, pinv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    if (inputs.get(slot.index)) transferStack(inputs, slot.index, pinv, null, [0, HOTBAR_SIZE]);
    return true;
  }

  let shelves = 0;
  try { shelves = clamp(countBookshelves(world, ctx.x | 0, ctx.y | 0, ctx.z | 0) | 0, 0, MAX_BOOKSHELVES); } catch { shelves = 0; }
  if (player && player.enchantSeed === undefined) {
    player.enchantSeed = (Math.random() * 0x7fffffff) | 0;
  }
  let seed = (player && player.enchantSeed) || 12345;
  let offers = [];

  const reroll = () => {
    const item = inputs.get(0);
    offers = [];
    if (item) {
      try { offers = tableOffers(item, shelves, null, seed) || []; } catch { offers = []; }
    }
    refreshOffers();
  };

  const refreshOffers = () => {
    const item = inputs.get(0);
    const lapis = inputs.get(1);
    const lapisCount = lapis ? (lapis.count | 0) : 0;
    const creative = isCreative(player);
    const level = player ? (player.xpLevel | 0) : 0;
    for (let i = 0; i < 3; i++) {
      const r = rows[i];
      const o = offers[i];
      if (!item || !o || !o.level) {
        r.row.classList.add('disabled');
        r.lapis.textContent = '';
        r.runes.textContent = '';
        r.clue.textContent = '';
        r.lvl.textContent = '';
        continue;
      }
      const affordable = creative || (lapisCount >= o.lapis && level >= o.level);
      r.row.classList.toggle('disabled', !affordable);
      r.lapis.textContent = String(o.lapis);
      r.runes.textContent = galacticText((seed ^ (i * 2654435761)) >>> 0, 3 + (i % 2));
      r.clue.textContent = o.hint || '?';
      r.lvl.textContent = String(o.level);
      r.row.title = o.hint ? o.hint + '  (' + o.level + ' levels, ' + o.lapis + ' lapis)' : '';
    }
    if (!item) hint.textContent = 'Place an item and lapis lazuli';
    else if (!offers.length || !offers.some((o) => o.level)) hint.textContent = 'This item cannot be enchanted';
    else hint.textContent = shelves + ' bookshelves — hover a row for a hint';
  };

  const pick = (i) => {
    const o = offers[i];
    const item = inputs.get(0);
    if (!o || !o.level || !item) { sound('click', 0.3, 0.7); return; }
    const creative = isCreative(player);
    const lapis = inputs.get(1);
    const lapisCount = lapis ? (lapis.count | 0) : 0;
    const level = player ? (player.xpLevel | 0) : 0;
    if (!creative && (lapisCount < o.lapis || level < o.level)) { sound('click', 0.3, 0.7); return; }

    let out = copyStack(item);
    if (out.item === 'book') { out.item = 'enchanted_book'; }
    try { applyOffer(out, o); } catch { /* keep the plain item */ }
    if ((out.count | 0) > 1) {
      out.count = 1;
      item.count -= 1;
      inputs.set(0, item);
      const pinv = player && player.inventory;
      const over = pinv ? pinv.add(out) : out;
      if (over) this._returnToPlayer(player, over);
    } else {
      inputs.set(0, out);
    }
    if (!creative) {
      if (lapis) {
        if (lapisCount <= o.lapis) inputs.set(1, null);
        else { lapis.count -= o.lapis; inputs.set(1, lapis); }
      }
      if (player) {
        // Vanilla charges (slot + 1) levels, not the displayed requirement.
        player.xpLevel = Math.max(0, level - o.lapis);
        player.xpProgress = 0;
      }
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      if (player) player.enchantSeed = seed;
    }
    sound('enchant_table_use', 0.7, 1);
    reroll();
    this.refresh();
  };

  this.buildPlayerRows(b, player, inputs, [0, 2]);
  for (const slot of this.slots) {
    if (slot.group !== 'player') continue;
    slot.quick = (s) => {
      const st = s.get();
      if (!st) return true;
      const pinv = player.inventory;
      if (st.item === 'lapis_lazuli') this.moveToContainer(pinv, s.index, inputs, [1, 2]);
      else this.moveToContainer(pinv, s.index, inputs, [0, 1]);
      reroll();
      return true;
    };
  }
  reroll();

  let t = 0;
  return {
    refresh: refreshOffers,
    frame: (dt) => {
      t += dt;
      if (!bookCtx) return;
      const g = bookCtx;
      const w = bookCanvas.width, h = bookCanvas.height;
      g.clearRect(0, 0, w, h);
      const flap = Math.sin(t * 2.2) * 0.5 + 0.5;
      const open = 0.35 + flap * 0.45;
      const cx = w / 2, cy = h * 0.62;
      // covers
      g.fillStyle = '#7a1f1f';
      g.beginPath();
      g.moveTo(cx, cy - 26);
      g.lineTo(cx - 34 * open, cy - 18);
      g.lineTo(cx - 34 * open, cy + 14);
      g.lineTo(cx, cy + 6);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(cx, cy - 26);
      g.lineTo(cx + 34 * open, cy - 18);
      g.lineTo(cx + 34 * open, cy + 14);
      g.lineTo(cx, cy + 6);
      g.closePath();
      g.fill();
      // pages
      g.fillStyle = '#efe6cf';
      g.beginPath();
      g.moveTo(cx, cy - 22);
      g.lineTo(cx - 29 * open, cy - 15);
      g.lineTo(cx - 29 * open, cy + 9);
      g.lineTo(cx, cy + 3);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(cx, cy - 22);
      g.lineTo(cx + 29 * open, cy - 15);
      g.lineTo(cx + 29 * open, cy + 9);
      g.lineTo(cx, cy + 3);
      g.closePath();
      g.fill();
      // rune scribbles
      g.fillStyle = 'rgba(60,40,90,0.55)';
      for (let i = 0; i < 4; i++) {
        const yy = cy - 12 + i * 5;
        g.fillRect(cx - 24 * open, yy, 18 * open, 1.5);
        g.fillRect(cx + 6 * open, yy, 18 * open, 1.5);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// brewing stand
// ---------------------------------------------------------------------------
BUILDERS.brewing = function brewingScreen(screen, ctx) {
  const player = playerOf(ctx);
  const world = ctx.world || (player && player.world) || Game.world;
  const inv = beInventory(world, ctx.x | 0, ctx.y | 0, ctx.z | 0, 5, 'brewing_stand');
  const be = inv.be;
  be.type = 'brewing_stand';
  if (typeof be.brewTime !== 'number') be.brewTime = 0;
  if (typeof be.fuel !== 'number') be.fuel = 0;
  this.watch(inv);

  title(screen, 'Brewing Stand');
  const b = body(screen);
  const stand = el('div', 'brewing-stand', b);

  const ingBox = el('div', 'brew-ingredient', stand);
  const fuelBox = el('div', 'brew-fuel', stand);
  const arrow = el('div', 'brew-arrow', stand);
  const bubbles = el('div', 'brew-bubbles', stand);
  const bottles = el('div', 'brew-bottles', stand);

  const toPlayer = (slot) => {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    this.moveToPlayer(inv, slot.index, pinv);
    return true;
  };

  for (let i = 0; i < BREW_BOTTLE_COUNT; i++) {
    this.addSlot({
      inv,
      index: i,
      parent: bottles,
      quick: toPlayer,
      limit: 1,
      filter: (s) => s.item === 'glass_bottle' || isPotionItem(s.item),
    });
  }
  this.addSlot({
    inv,
    index: BREW_SLOT_INGREDIENT,
    parent: ingBox,
    quick: toPlayer,
    filter: (s) => isValidBrewIngredient(s.item),
  });
  this.addSlot({
    inv,
    index: BREW_SLOT_FUEL,
    parent: fuelBox,
    quick: toPlayer,
    filter: (s) => isBrewFuel(s.item),
  });

  this.buildPlayerRows(b, player, inv);
  for (const slot of this.slots) {
    if (slot.group !== 'player') continue;
    slot.quick = (s) => {
      const st = s.get();
      if (!st) return true;
      const pinv = player.inventory;
      if (isBrewFuel(st.item)) this.moveToContainer(pinv, s.index, inv, [BREW_SLOT_FUEL, BREW_SLOT_FUEL + 1]);
      else if (isValidBrewIngredient(st.item)) this.moveToContainer(pinv, s.index, inv, [BREW_SLOT_INGREDIENT, BREW_SLOT_INGREDIENT + 1]);
      else if (st.item === 'glass_bottle' || isPotionItem(st.item)) this.moveToContainer(pinv, s.index, inv, [0, BREW_BOTTLE_COUNT]);
      else this._playerInternalMove(s, pinv);
      return true;
    };
  }

  return {
    refresh: () => {
      let p = 0;
      try { p = brewProgress(be); } catch { p = 0; }
      arrow.style.setProperty('--progress', String(clamp(p, 0, 1)));
      bubbles.style.setProperty('--fuel', String(clamp((be.fuel || 0) / BREW_FUEL_USES, 0, 1)));
    },
    // The world drives brewing now (blockupdate.js tickBrewingStands), so a
    // stand keeps working with its screen closed. Ticking here as well would
    // brew at double speed whenever the screen is open.
    tick: () => true,
  };
};

// ---------------------------------------------------------------------------
// villager trading
// ---------------------------------------------------------------------------
BUILDERS.trading = function tradingScreen(screen, ctx) {
  const player = playerOf(ctx);
  const villager = ctx.villager || ctx.entity || null;
  if (villager) { try { ensureTrades(villager); } catch { /* keeps whatever it has */ } }
  const trades = (villager && Array.isArray(villager.trades) ? villager.trades : []);

  const label = villager && villager.profession ? prettyName(villager.profession)
    : (villager && villager.type === 'wandering_trader' ? 'Wandering Trader' : 'Villager');
  title(screen, label);
  const b = body(screen);

  const head = el('div', 'mc-row', b);
  const levelBadge = el('div', 'villager-level', head, '');
  el('div', 'mc-spacer', head);
  const xpBar = el('div', 'trade-xp', head);
  const xpFill = el('div', '', xpBar);

  const layout = el('div', 'trading', b);
  const list = el('div', 'trade-list mc-scroll', layout);
  const detail = el('div', 'mc-col', layout);

  let selected = 0;
  const rowEls = [];

  const inputs = this.temp(2, 'trade_inputs');
  const outInv = new Inventory(1, 'trade_output');
  this.watch(outInv);

  const detailRow = el('div', 'mc-row', detail);
  detailRow.style.alignItems = 'center';
  detailRow.style.gap = 'var(--u4)';
  const buyBox = el('div', '', detailRow);
  const buyBBox = el('div', '', detailRow);
  el('div', 'trade-arrow', detailRow);
  const sellBox = el('div', '', detailRow);

  // These two slots only PREVIEW what the trade costs. The payment itself is
  // taken straight from the player's inventory by useTrade(), so the stacks
  // here were fabricated - and they were takeable, which meant selecting a
  // trade and shift-clicking the price slot minted free items on repeat.
  this.addSlot({ inv: inputs, index: 0, parent: buyBox, readOnly: true });
  this.addSlot({ inv: inputs, index: 1, parent: buyBBox, readOnly: true });

  const sellSlot = this.addSlot({
    inv: outInv,
    index: 0,
    parent: sellBox,
    className: 'result',
    takeOnly: true,
    onTaken: () => { /* handled by doTrade */ },
  });
  sellSlot.canTake = () => false;
  sellSlot.el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); doTrade(); });

  const status = el('div', 'mc-hint', detail, '');
  button('Trade', detail, () => doTrade(), 'primary');

  const screens = this;
  function doTrade() {
    const t = trades[selected];
    if (!t || !villager || !player) return;
    if (!canUseTrade(villager, t, player)) {
      try { refuseTrade(villager, player); } catch { /* optional */ }
      sound('click', 0.35, 0.7);
      return;
    }
    let ok = false;
    try { ok = !!useTrade(villager, t, player); } catch (err) { console.error('[screens] trade', err); }
    if (ok) sound('villager_yes', 0.5, 1);
    screens.refresh();
    rebuild();
  }

  const select = (i) => {
    selected = i;
    for (let k = 0; k < rowEls.length; k++) rowEls[k].classList.toggle('selected', k === i);
    syncDetail();
  };

  const syncDetail = () => {
    const t = trades[selected];
    inputs.slots[0] = null;
    inputs.slots[1] = null;
    outInv.slots[0] = null;
    if (t) {
      const price = villager && player ? safePrice(t) : (t.buy ? t.buy.count : 1);
      if (t.buy) inputs.slots[0] = { item: t.buy.item, count: Math.max(1, price | 0), damage: 0 };
      if (t.buyB && (t.buyB.count | 0) > 0) inputs.slots[1] = { item: t.buyB.item, count: t.buyB.count | 0, damage: 0 };
      if (t.sell) outInv.slots[0] = copyStack(t.sell);
      const usable = villager && player ? canUseTrade(villager, t, player) : false;
      status.textContent = !tradeInStock(t) ? 'Out of stock — come back later'
        : (usable ? 'Ready to trade' : 'You are missing the items');
    } else {
      status.textContent = 'No offers';
    }
    inputs.markChanged(-1);
    outInv.markChanged(-1);
  };

  const safePrice = (t) => {
    try { return tradePrice(t, villager, player); } catch { return t.buy ? t.buy.count : 1; }
  };

  const rebuild = () => {
    while (list.firstChild) list.removeChild(list.firstChild);
    rowEls.length = 0;
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const locked = !tradeInStock(t);
      const row = el('div', 'trade-row' + (locked ? ' locked' : '') + (i === selected ? ' selected' : ''), list);
      const addIcon = (s, count) => {
        if (!s) return;
        const wrap = el('div', 'mc-row', row);
        wrap.style.alignItems = 'center';
        const img = setIcon(el('img', '', wrap), s.item);
        img.title = tradeStackName(s);
        el('span', 'slot-count', wrap, String(count || s.count || 1)).style.position = 'static';
      };
      addIcon(t.buy, safePrice(t));
      if (t.buyB && (t.buyB.count | 0) > 0) addIcon(t.buyB, t.buyB.count);
      el('div', 'trade-arrow', row);
      addIcon(t.sell, t.sell ? t.sell.count : 1);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        click();
        select(i);
        if (e.detail >= 2) doTrade();
      });
      rowEls.push(row);
    }
    if (!trades.length) el('div', 'mc-hint', list, 'This villager has nothing to offer.');
    syncDetail();
  };

  this.buildPlayerRows(b, player, null);
  rebuild();

  return {
    refresh: () => {
      let lp = { level: 1, name: 'novice', progress: 0 };
      try { lp = levelProgress(villager) || lp; } catch { /* defaults */ }
      levelBadge.textContent = prettyName(lp.name) + ' — Level ' + lp.level;
      xpFill.style.setProperty('--value', String(clamp(lp.progress || 0, 0, 1)));
      const t = trades[selected];
      if (t) {
        const usable = villager && player ? canUseTrade(villager, t, player) : false;
        status.textContent = !tradeInStock(t) ? 'Out of stock — come back later'
          : (usable ? 'Ready to trade' : 'You are missing the items');
      }
    },
    dispose: () => {
      // The preview slots hold synthetic stacks; never hand those to the player.
      inputs.slots[0] = null;
      inputs.slots[1] = null;
    },
  };
};

// ---------------------------------------------------------------------------
// creative inventory
// ---------------------------------------------------------------------------
const CREATIVE_COLS = 9;
const CREATIVE_ROWS = 6;

BUILDERS.creative = function creativeScreen(screen, ctx) {
  const player = playerOf(ctx);
  const inv = player && player.inventory;
  title(screen, 'Creative Inventory');
  screen.classList.add('wide');
  const b = body(screen);

  const tabStrip = el('div', 'creative-tabs', b);
  const content = el('div', 'mc-col', b);

  const tabs = [];
  for (const t of CREATIVE_TABS) tabs.push({ id: t.id, name: t.name, icon: t.icon, items: t.items });
  tabs.push({ id: '__search', name: 'Search Items', icon: 'compass', items: null });
  tabs.push({ id: '__inventory', name: 'Survival Inventory', icon: 'chest', items: null });

  let active = tabs.length ? tabs[0].id : '__search';
  let page = 0;
  let query = '';

  const tabEls = [];
  for (const t of tabs) {
    const e = el('div', 'creative-tab', tabStrip);
    setIcon(el('img', '', e), t.icon || 'stone');
    e.title = t.name;
    e.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      click();
      active = t.id;
      page = 0;
      render();
    });
    tabEls.push({ id: t.id, el: e });
  }

  const render = () => {
    while (content.firstChild) content.removeChild(content.firstChild);
    // Only slots belonging to the previous tab layout are dropped.
    this.slots = this.slots.filter((s) => s.group === 'keep');
    for (const te of tabEls) te.el.classList.toggle('active', te.id === active);

    if (active === '__inventory') {
      renderSurvival();
      this.refresh();
      return;
    }
    const header = el('div', 'mc-row', content);
    el('div', 'mc-label', header, tabs.find((t) => t.id === active).name);
    el('div', 'mc-spacer', header);

    let names;
    if (active === '__search') {
      const search = el('input', 'mc-input recipe-search', header);
      search.type = 'text';
      search.placeholder = 'Search items…';
      search.value = query;
      search.spellcheck = false;
      search.addEventListener('keydown', (e) => e.stopPropagation());
      search.addEventListener('input', () => {
        query = search.value.trim().toLowerCase();
        page = 0;
        renderGrid();
      });
      setTimeout(() => { try { search.focus(); } catch { /* ok */ } }, 0);
    }

    const gridWrap = el('div', 'mc-col creative-grid-scroll', content);
    const grid = el('div', 'slot-grid', gridWrap);
    const nav = el('div', 'mc-row', content);
    const prev = el('button', 'mc-button small', nav, '◀');
    prev.type = 'button';
    const pageLabel = el('span', 'mc-hint', nav, '');
    const next = el('button', 'mc-button small', nav, '▶');
    next.type = 'button';
    el('div', 'mc-spacer', nav);
    el('span', 'mc-hint', nav, 'Destroy Item');
    const destroyBox = el('div', '', nav);

    const destroy = this.addSlot({
      parent: destroyBox,
      className: 'result',
      get: () => null,
      set: () => {},
      group: 'creative',
    });
    destroy.canPlace = () => !!this.held;
    destroy.el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.held) { this.setHeld(null); sound('fizz', 0.4, 0.9); this.refresh(); }
    }, true);
    destroy.el.title = 'Destroy Item';

    const collect = () => {
      if (active === '__search') {
        const out = [];
        for (const n of ITEM_NAMES) {
          const def = ITEMS[n];
          if (!def || def.stub || n === 'air') continue;
          if (query) {
            const disp = (def.display || prettyName(n)).toLowerCase();
            if (disp.indexOf(query) < 0 && n.indexOf(query) < 0) continue;
          }
          out.push(n);
          if (out.length >= 2000) break;
        }
        return out;
      }
      const tab = tabs.find((t) => t.id === active);
      return (tab && tab.items) || [];
    };
    names = collect();
    const perPage = CREATIVE_COLS * CREATIVE_ROWS;

    const renderGrid = () => {
      names = collect();
      const total = Math.max(1, Math.ceil(names.length / perPage));
      page = clamp(page, 0, total - 1);
      while (grid.firstChild) grid.removeChild(grid.firstChild);
      this.slots = this.slots.filter((s) => s.group !== 'creative_cell');
      const start = page * perPage;
      for (let i = start; i < Math.min(names.length, start + perPage); i++) {
        const name = names[i];
        const cell = this.addSlot({
          parent: grid,
          group: 'creative_cell',
          get: () => mkStack(name, maxOf({ item: name, count: 1 })),
          set: () => {},
          readOnly: true,
        });
        cell.el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.held) { this.setHeld(null); sound('fizz', 0.35, 0.9); this.refresh(); return; }
          const size = e.button === 2 ? 1 : maxOf({ item: name, count: 1 });
          const s = mkStack(name, size);
          if (e.shiftKey) {
            if (inv) {
              const over = inv.add(s);
              if (over) this._returnToPlayer(player, over);
            }
          } else {
            this.setHeld(s);
          }
          click();
          this.refresh();
        }, true);
        cell.render();
      }
      pageLabel.textContent = (page + 1) + ' / ' + total;
    };

    prev.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); click(); page--; renderGrid(); });
    next.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); click(); page++; renderGrid(); });
    gridWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      page += e.deltaY > 0 ? 1 : -1;
      renderGrid();
    }, { passive: false });
    renderGrid();

    // The hotbar stays visible on every creative tab.
    const hot = el('div', 'hotbar-grid', content);
    if (inv) {
      for (let i = 0; i < HOTBAR_SIZE; i++) {
        this.addSlot({ inv, index: i, parent: hot, group: 'creative' });
      }
    }
    this.refresh();
  };

  const renderSurvival = () => {
    const top = el('div', 'mc-row', content);
    top.style.gap = 'var(--u6)';
    top.style.alignItems = 'flex-start';
    this.buildArmorSlots(top, player);
    this.buildPlayerPreview(top, player);
    const offCol = el('div', 'mc-col', top);
    if (inv) this.addSlot({ inv, index: OFFHAND_SLOT, parent: offCol, className: 'offhand-slot', group: 'creative' });
    el('div', 'mc-spacer', top);
    const destroyBox = el('div', '', top);
    const destroy = this.addSlot({
      parent: destroyBox,
      className: 'result',
      get: () => null,
      set: () => {},
      group: 'creative',
    });
    destroy.el.title = 'Destroy Item';
    destroy.el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.held) { this.setHeld(null); sound('fizz', 0.4, 0.9); this.refresh(); }
    }, true);
    this.buildPlayerRows(content, player, null);
  };

  render();
  return {};
};

// ---------------------------------------------------------------------------
// beacon
// ---------------------------------------------------------------------------
const BEACON_POWERS = [
  ['speed', 'haste'],
  ['resistance', 'jump_boost'],
  ['strength'],
];
const BEACON_PAYMENTS = ['netherite_ingot', 'emerald', 'diamond', 'gold_ingot', 'iron_ingot'];
const BEACON_BASE_BLOCKS = new Set([
  'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'netherite_block',
]);

BUILDERS.beacon = function beaconScreen(screen, ctx) {
  const player = playerOf(ctx);
  const world = ctx.world || (player && player.world) || Game.world;
  const inv = beInventory(world, ctx.x | 0, ctx.y | 0, ctx.z | 0, 1, 'beacon');
  const be = inv.be;
  title(screen, 'Beacon');
  const b = body(screen);

  // Pyramid level: count complete rings of mineral blocks under the beacon.
  let levels = 0;
  try {
    const bx = ctx.x | 0, by = ctx.y | 0, bz = ctx.z | 0;
    for (let l = 1; l <= 4 && world; l++) {
      let ok = true;
      for (let dx = -l; dx <= l && ok; dx++) {
        for (let dz = -l; dz <= l && ok; dz++) {
          const id = world.getBlock(bx + dx, by - l, bz + dz);
          const name = id ? (getBlock(id).name || '') : '';
          if (!BEACON_BASE_BLOCKS.has(name)) ok = false;
        }
      }
      if (ok) levels = l; else break;
    }
  } catch { levels = 0; }

  el('div', 'mc-label', b, 'Pyramid level ' + levels + ' / 4');
  const payRow = el('div', 'mc-row', b);
  el('div', 'mc-label', payRow, 'Payment');
  this.addSlot({
    inv,
    index: 0,
    parent: payRow,
    filter: (s) => BEACON_PAYMENTS.indexOf(s.item) >= 0,
  });

  let primary = be.primary || null;
  let secondary = be.secondary || null;

  const powersBox = el('div', 'mc-col', b);
  const buttons = [];
  for (let tier = 0; tier < BEACON_POWERS.length; tier++) {
    const row = el('div', 'mc-row', powersBox);
    el('div', 'mc-label', row, 'Tier ' + (tier + 1));
    for (const name of BEACON_POWERS[tier]) {
      const btn = el('button', 'mc-button small', row, prettyName(name));
      btn.type = 'button';
      const unlocked = levels > tier;
      if (!unlocked) btn.setAttribute('disabled', 'disabled');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!unlocked) return;
        click();
        primary = primary === name ? null : name;
        sync();
      });
      buttons.push({ btn, name, tier });
    }
  }
  const secRow = el('div', 'mc-row', powersBox);
  el('div', 'mc-label', secRow, 'Tier 4');
  const regenBtn = el('button', 'mc-button small', secRow, 'Regeneration');
  regenBtn.type = 'button';
  if (levels < 4) regenBtn.setAttribute('disabled', 'disabled');
  regenBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (levels < 4) return;
    click();
    secondary = secondary === 'regeneration' ? null : 'regeneration';
    sync();
  });

  const status = el('div', 'mc-hint', b, '');
  button('Confirm', b, () => {
    const pay = inv.get(0);
    if (!levels) { status.textContent = 'Build a pyramid under the beacon first.'; return; }
    if (!pay && !isCreative(player)) { status.textContent = 'A payment item is required.'; return; }
    if (pay) {
      if ((pay.count | 0) <= 1) inv.set(0, null);
      else { pay.count -= 1; inv.set(0, pay); }
    }
    be.primary = primary;
    be.secondary = secondary;
    be.levels = levels;
    be.dirty = true;
    const ticks = (9 + levels * 2) * 20;
    if (player && typeof player.addEffect === 'function') {
      try {
        if (primary) player.addEffect(primary, ticks, secondary === primary ? 1 : 0);
        if (secondary && secondary !== primary) player.addEffect(secondary, ticks, 0);
      } catch { /* effects are optional */ }
    }
    sound('beacon_activate', 0.7, 1);
    status.textContent = 'Beacon activated.';
    this.refresh();
  }, 'primary');

  const sync = () => {
    for (const x of buttons) x.btn.classList.toggle('active', x.name === primary);
    regenBtn.classList.toggle('active', secondary === 'regeneration');
    status.textContent = primary ? 'Primary: ' + prettyName(primary)
      + (secondary ? ', Secondary: ' + prettyName(secondary) : '') : 'Choose a power';
  };
  sync();

  this.buildPlayerRows(b, player, inv);
  return {};
};

// ---------------------------------------------------------------------------
// loom
// ---------------------------------------------------------------------------
const LOOM_PATTERNS = [
  'base', 'stripe_bottom', 'stripe_top', 'stripe_left', 'stripe_right', 'stripe_center',
  'stripe_middle', 'stripe_downright', 'stripe_downleft', 'cross', 'straight_cross',
  'diagonal_left', 'diagonal_right', 'half_horizontal', 'half_vertical', 'square_bottom_left',
  'square_bottom_right', 'square_top_left', 'square_top_right', 'triangle_bottom',
  'triangle_top', 'circle', 'rhombus', 'border', 'curly_border', 'bricks', 'gradient',
  'creeper', 'skull', 'flower', 'mojang', 'globe',
];

BUILDERS.loom = function loomScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Loom');
  const b = body(screen);
  const inputs = this.temp(3, 'loom');
  const outInv = new Inventory(1, 'loom_out');
  this.watch(outInv);

  const row = el('div', 'mc-row', b);
  row.style.gap = 'var(--u4)';
  row.style.alignItems = 'center';
  const bannerBox = el('div', '', row);
  const dyeBox = el('div', '', row);
  const patternBox = el('div', '', row);
  el('div', 'crafting-arrow', row);
  const outBox = el('div', '', row);

  let picked = 0;
  const listWrap = el('div', 'recipe-book', b);
  const list = el('div', 'recipe-results', listWrap);

  const recompute = () => {
    const banner = inputs.get(0);
    const dye = inputs.get(1);
    let out = null;
    if (banner && dye && /_banner$/.test(banner.item) && /_dye$/.test(dye.item)) {
      out = copyStack(banner);
      out.count = 1;
      const patterns = Array.isArray(out.patterns) ? out.patterns.slice() : [];
      if (patterns.length < 6) {
        patterns.push({ pattern: LOOM_PATTERNS[picked] || 'base', color: dye.item.replace(/_dye$/, '') });
        out.patterns = patterns;
      } else {
        out = null;
      }
    }
    outInv.slots[0] = out;
    outInv.markChanged(0);
  };

  const back = (slot) => {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    transferStack(inputs, slot.index, pinv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    if (inputs.get(slot.index)) transferStack(inputs, slot.index, pinv, null, [0, HOTBAR_SIZE]);
    recompute();
    return true;
  };

  inputs.onChange = () => recompute();
  this.addSlot({ inv: inputs, index: 0, parent: bannerBox, filter: (s) => /_banner$/.test(s.item), quick: back });
  this.addSlot({ inv: inputs, index: 1, parent: dyeBox, filter: (s) => /_dye$/.test(s.item), quick: back });
  this.addSlot({ inv: inputs, index: 2, parent: patternBox, filter: (s) => /banner_pattern$/.test(s.item), quick: back });

  this.addSlot({
    inv: outInv,
    index: 0,
    parent: outBox,
    className: 'result',
    takeOnly: true,
    onTaken: () => {
      const banner = inputs.get(0);
      const dye = inputs.get(1);
      if (banner) { if ((banner.count | 0) <= 1) inputs.set(0, null); else { banner.count -= 1; inputs.set(0, banner); } }
      if (dye) { if ((dye.count | 0) <= 1) inputs.set(1, null); else { dye.count -= 1; inputs.set(1, dye); } }
      sound('craft', 0.4, 1);
      recompute();
    },
  });

  for (let i = 0; i < LOOM_PATTERNS.length; i++) {
    // `picked` starts at 0, so the first pattern must render marked.
    const e = el('div', 'recipe-entry' + (i === picked ? ' selected' : ''), list, '');
    e.title = prettyName(LOOM_PATTERNS[i]);
    el('span', 'mc-hint', e, LOOM_PATTERNS[i].slice(0, 2).toUpperCase());
    e.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      click();
      picked = i;
      // `.locked` means unavailable and renders greyed out with a
      // not-allowed cursor; the selected pattern needs its own marker.
      for (const c of list.children) c.classList.remove('selected');
      e.classList.add('selected');
      recompute();
      this.refresh();
    });
  }

  this.buildPlayerRows(b, player, inputs, [0, 3]);
  recompute();
  return {};
};

// ---------------------------------------------------------------------------
// stonecutter
// ---------------------------------------------------------------------------
BUILDERS.stonecutter = function stonecutterScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Stonecutter');
  const b = body(screen);
  const inputs = this.temp(1, 'stonecutter');
  const outInv = new Inventory(1, 'stonecutter_out');
  this.watch(outInv);

  const row = el('div', 'mc-row', b);
  row.style.gap = 'var(--u4)';
  row.style.alignItems = 'center';
  const inBox = el('div', '', row);
  el('div', 'crafting-arrow', row);
  const outBox = el('div', '', row);

  const listWrap = el('div', 'recipe-book', b);
  const list = el('div', 'recipe-results', listWrap);
  let options = [];
  let picked = 0;

  const recompute = () => {
    const input = inputs.get(0);
    options = input ? (stonecuttingFor(input.item) || []) : [];
    if (picked >= options.length) picked = 0;
    const chosen = options[picked];
    outInv.slots[0] = chosen ? mkStack(chosen.output, chosen.count || 1) : null;
    outInv.markChanged(0);
    rebuildList();
  };

  const rebuildList = () => {
    while (list.firstChild) list.removeChild(list.firstChild);
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const e = el('div', 'recipe-entry' + (i === picked ? ' selected' : ''), list);
      setIcon(el('img', '', e), o.output);
      e.title = getItem(o.output).display || prettyName(o.output);
      e.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        click();
        picked = i;
        recompute();
        this.refresh();
      });
    }
    if (!options.length) el('div', 'mc-hint', list, 'Nothing to cut');
  };

  inputs.onChange = () => recompute();
  this.addSlot({
    inv: inputs,
    index: 0,
    parent: inBox,
    quick: (slot) => {
      const pinv = player && player.inventory;
      if (!pinv) return false;
      transferStack(inputs, slot.index, pinv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
      if (inputs.get(slot.index)) transferStack(inputs, slot.index, pinv, null, [0, HOTBAR_SIZE]);
      recompute();
      return true;
    },
  });

  this.addSlot({
    inv: outInv,
    index: 0,
    parent: outBox,
    className: 'result',
    takeOnly: true,
    onTaken: () => {
      const input = inputs.get(0);
      if (input) {
        if ((input.count | 0) <= 1) inputs.set(0, null);
        else { input.count -= 1; inputs.set(0, input); }
      }
      sound('dig_stone', 0.35, 1.3);
      recompute();
    },
  });

  this.buildPlayerRows(b, player, inputs, [0, 1]);
  recompute();
  return {};
};

// ---------------------------------------------------------------------------
// grindstone
// ---------------------------------------------------------------------------
BUILDERS.grindstone = function grindstoneScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Repair & Disenchant');
  const b = body(screen);
  const inputs = this.temp(2, 'grindstone');
  const outInv = new Inventory(1, 'grindstone_out');
  this.watch(outInv);

  const row = el('div', 'mc-row', b);
  row.style.gap = 'var(--u4)';
  row.style.alignItems = 'center';
  const aBox = el('div', 'mc-col', row);
  const bBox = el('div', 'mc-col', row);
  el('div', 'crafting-arrow', row);
  const outBox = el('div', '', row);
  const info = el('div', 'mc-hint', b, '');

  let res = null;
  const recompute = () => {
    try { res = grindstoneResult(inputs.get(0), inputs.get(1), null); } catch { res = null; }
    outInv.slots[0] = res && res.stack ? res.stack : null;
    outInv.markChanged(0);
    info.textContent = res && res.xp ? 'Grinding returns about ' + res.xp + ' XP' : '';
  };

  const back = (slot) => {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    transferStack(inputs, slot.index, pinv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    if (inputs.get(slot.index)) transferStack(inputs, slot.index, pinv, null, [0, HOTBAR_SIZE]);
    recompute();
    return true;
  };
  inputs.onChange = () => recompute();
  this.addSlot({ inv: inputs, index: 0, parent: aBox, quick: back });
  this.addSlot({ inv: inputs, index: 1, parent: bBox, quick: back });

  this.addSlot({
    inv: outInv,
    index: 0,
    parent: outBox,
    className: 'result',
    takeOnly: true,
    onTaken: () => {
      if (res && res.xp && player && typeof player.addXP === 'function') {
        try { player.addXP(res.xp); } catch { /* optional */ }
      }
      inputs.set(0, null);
      inputs.set(1, null);
      sound('grindstone_use', 0.5, 1);
      recompute();
    },
  });

  this.buildPlayerRows(b, player, inputs, [0, 2]);
  recompute();
  return {};
};

// ---------------------------------------------------------------------------
// smithing table
// ---------------------------------------------------------------------------
BUILDERS.smithing = function smithingScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Upgrade Gear');
  const b = body(screen);
  const inputs = this.temp(3, 'smithing');
  const outInv = new Inventory(1, 'smithing_out');
  this.watch(outInv);

  const row = el('div', 'mc-row', b);
  row.style.gap = 'var(--u4)';
  row.style.alignItems = 'center';
  const tBox = el('div', '', row);
  const baseBox = el('div', '', row);
  const addBox = el('div', '', row);
  el('div', 'crafting-arrow', row);
  const outBox = el('div', '', row);
  const hint = el('div', 'mc-hint', b, 'Template + gear + material');

  const recompute = () => {
    let out = null;
    try { out = smithingResult(inputs.get(0), inputs.get(1), inputs.get(2)); } catch { out = null; }
    outInv.slots[0] = out;
    outInv.markChanged(0);
    hint.textContent = out ? (getItem(out.item).display || prettyName(out.item)) : 'Template + gear + material';
  };
  const back = (slot) => {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    transferStack(inputs, slot.index, pinv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    if (inputs.get(slot.index)) transferStack(inputs, slot.index, pinv, null, [0, HOTBAR_SIZE]);
    recompute();
    return true;
  };
  inputs.onChange = () => recompute();
  for (let i = 0; i < 3; i++) {
    this.addSlot({ inv: inputs, index: i, parent: [tBox, baseBox, addBox][i], quick: back });
  }
  this.addSlot({
    inv: outInv,
    index: 0,
    parent: outBox,
    className: 'result',
    takeOnly: true,
    onTaken: () => {
      for (let i = 0; i < 3; i++) {
        const s = inputs.get(i);
        if (!s) continue;
        if ((s.count | 0) <= 1) inputs.set(i, null);
        else { s.count -= 1; inputs.set(i, s); }
      }
      sound('anvil_use', 0.5, 1.2);
      recompute();
    },
  });

  this.buildPlayerRows(b, player, inputs, [0, 3]);
  recompute();
  return {};
};

// ---------------------------------------------------------------------------
// cartography table
// ---------------------------------------------------------------------------
BUILDERS.cartography = function cartographyScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Cartography Table');
  const b = body(screen);
  const inputs = this.temp(2, 'cartography');
  const outInv = new Inventory(1, 'cartography_out');
  this.watch(outInv);

  const row = el('div', 'mc-row', b);
  row.style.gap = 'var(--u4)';
  row.style.alignItems = 'center';
  const mapBox = el('div', '', row);
  const addBox = el('div', '', row);
  el('div', 'crafting-arrow', row);
  const outBox = el('div', '', row);
  el('div', 'mc-hint', b, 'Map + paper (zoom), glass pane (lock), empty map (copy)');

  const recompute = () => {
    const map = inputs.get(0);
    const add = inputs.get(1);
    let out = null;
    if (map && (map.item === 'filled_map' || map.item === 'map')) {
      if (add && add.item === 'paper') {
        out = copyStack(map);
        out.count = 1;
        out.zoom = clamp(((out.zoom | 0) + 1), 0, 4);
      } else if (add && (add.item === 'glass_pane' || /_stained_glass_pane$/.test(add.item))) {
        out = copyStack(map);
        out.count = 1;
        out.locked = true;
      } else if (add && (add.item === 'map' || add.item === 'empty_map')) {
        out = copyStack(map);
        out.count = 2;
      }
    }
    outInv.slots[0] = out;
    outInv.markChanged(0);
  };
  const back = (slot) => {
    const pinv = player && player.inventory;
    if (!pinv) return false;
    transferStack(inputs, slot.index, pinv, null, [HOTBAR_SIZE, INV_MAIN_SIZE]);
    if (inputs.get(slot.index)) transferStack(inputs, slot.index, pinv, null, [0, HOTBAR_SIZE]);
    recompute();
    return true;
  };
  inputs.onChange = () => recompute();
  this.addSlot({ inv: inputs, index: 0, parent: mapBox, quick: back });
  this.addSlot({ inv: inputs, index: 1, parent: addBox, quick: back });
  this.addSlot({
    inv: outInv,
    index: 0,
    parent: outBox,
    className: 'result',
    takeOnly: true,
    onTaken: () => {
      for (let i = 0; i < 2; i++) {
        const s = inputs.get(i);
        if (!s) continue;
        if ((s.count | 0) <= 1) inputs.set(i, null);
        else { s.count -= 1; inputs.set(i, s); }
      }
      sound('craft', 0.4, 1);
      recompute();
    },
  });

  this.buildPlayerRows(b, player, inputs, [0, 2]);
  recompute();
  return {};
};

// ---------------------------------------------------------------------------
// sign editing
// ---------------------------------------------------------------------------
BUILDERS.sign = function signScreen(screen, ctx) {
  const player = playerOf(ctx);
  const world = ctx.world || (player && player.world) || Game.world;
  let be = null;
  try { be = world && world.getBlockEntity ? world.getBlockEntity(ctx.x | 0, ctx.y | 0, ctx.z | 0) : null; } catch { be = null; }
  if (!be) {
    be = { type: 'sign', x: ctx.x | 0, y: ctx.y | 0, z: ctx.z | 0, lines: ['', '', '', ''] };
    try { if (world && world.setBlockEntity) world.setBlockEntity(ctx.x | 0, ctx.y | 0, ctx.z | 0, be); } catch { /* transient */ }
  }
  if (!Array.isArray(be.lines)) be.lines = ['', '', '', ''];

  title(screen, 'Edit Sign');
  const b = body(screen);
  const fields = [];
  for (let i = 0; i < 4; i++) {
    const f = el('input', 'mc-input', b);
    f.type = 'text';
    f.maxLength = 15;
    f.value = be.lines[i] || '';
    f.spellcheck = false;
    f.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') {
        e.preventDefault();
        if (i < 3) fields[i + 1].focus();
        else this.close();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    f.addEventListener('input', () => { be.lines[i] = f.value; be.dirty = true; });
    fields.push(f);
  }
  setTimeout(() => { try { fields[0].focus(); } catch { /* ok */ } }, 0);

  const footer = el('div', 'screen-footer', screen);
  button('Done', footer, () => this.close(), 'primary');

  return {
    dispose: () => {
      for (let i = 0; i < 4; i++) be.lines[i] = fields[i].value;
      be.dirty = true;
      try {
        const c = world && world.chunkAt ? world.chunkAt(ctx.x | 0, ctx.z | 0) : null;
        if (c) { c.modified = true; }
        if (world && world.markDirty) world.markDirty(ctx.x | 0, ctx.y | 0, ctx.z | 0);
      } catch { /* optional */ }
    },
  };
};

// ---------------------------------------------------------------------------
// book: writing and reading
// ---------------------------------------------------------------------------
BUILDERS.book = function bookScreen(screen, ctx) {
  const player = playerOf(ctx);
  let bookStack = ctx.book || ctx.stack || null;
  if (!bookStack && player && typeof player.getHeldItem === 'function') {
    try { bookStack = player.getHeldItem(); } catch { bookStack = null; }
  }
  const writable = !!bookStack && (bookStack.item === 'writable_book' || bookStack.item === 'book_and_quill');
  if (bookStack && !Array.isArray(bookStack.pages)) bookStack.pages = [''];
  const pages = bookStack && Array.isArray(bookStack.pages) && bookStack.pages.length
    ? bookStack.pages : [''];
  let page = 0;

  title(screen, writable ? 'Book and Quill' : (bookStack ? stackDisplayName(bookStack) : 'Book'));
  const b = body(screen);

  const area = el(writable ? 'textarea' : 'div', 'mc-input', b);
  area.style.minHeight = 'calc(var(--gs) * 80px)';
  area.style.whiteSpace = 'pre-wrap';
  if (writable) {
    area.value = pages[page] || '';
    area.spellcheck = false;
    area.addEventListener('keydown', (e) => e.stopPropagation());
    area.addEventListener('input', () => { pages[page] = area.value; if (bookStack) bookStack.pages = pages; });
  } else {
    area.textContent = pages[page] || '';
  }

  const nav = el('div', 'mc-row', b);
  const prev = el('button', 'mc-button small', nav, 'Previous');
  prev.type = 'button';
  const label = el('span', 'mc-hint', nav, '');
  const next = el('button', 'mc-button small', nav, 'Next');
  next.type = 'button';

  const show = () => {
    page = clamp(page, 0, pages.length - 1);
    if (writable) area.value = pages[page] || '';
    else area.textContent = pages[page] || '';
    label.textContent = 'Page ' + (page + 1) + ' / ' + pages.length;
  };
  prev.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); click(); page--; show(); });
  next.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    click();
    if (page === pages.length - 1 && writable && pages.length < 50) pages.push('');
    page++;
    show();
  });

  const footer = el('div', 'screen-footer', screen);
  if (writable) {
    const titleField = el('input', 'mc-input', footer);
    titleField.type = 'text';
    titleField.placeholder = 'Book title';
    titleField.maxLength = 32;
    titleField.spellcheck = false;
    titleField.addEventListener('keydown', (e) => e.stopPropagation());
    button('Sign', footer, () => {
      if (!bookStack) return;
      const name = titleField.value.trim();
      if (!name) return;
      bookStack.item = 'written_book';
      bookStack.customName = name;
      bookStack.author = (player && player.name) || 'Player';
      bookStack.pages = pages;
      sound('book_page', 0.5, 1);
      this.close();
    }, 'primary');
  }
  button('Done', footer, () => this.close());

  show();
  return {
    dispose: () => {
      if (bookStack && writable) {
        pages[page] = writable ? area.value : pages[page];
        bookStack.pages = pages;
      }
    },
  };
};

// ---------------------------------------------------------------------------
// standalone recipe book overlay
// ---------------------------------------------------------------------------
BUILDERS.recipe_book = function recipeBookScreen(screen, ctx) {
  const player = playerOf(ctx);
  title(screen, 'Recipe Book');
  const b = body(screen);
  const row = el('div', 'mc-row', b);
  row.style.gap = 'var(--u6)';
  row.style.alignItems = 'flex-start';

  const left = el('div', 'mc-col', row);
  const craftRow = el('div', 'mc-row', left);
  craftRow.style.alignItems = 'center';
  craftRow.style.gap = 'var(--u4)';
  const gridEl = el('div', 'crafting-grid', craftRow);
  const arrow = el('div', 'crafting-arrow', craftRow);
  const resultBox = el('div', '', craftRow);
  const crafting = makeCrafting(this, gridEl, resultBox, 3, player);

  const bookWrap = el('div', 'mc-col', row);
  const book = buildRecipeBook(this, bookWrap, player, crafting, 3);

  this.buildPlayerRows(b, player, null);

  let n = 0;
  return {
    refresh: () => { arrow.classList.toggle('ready', !!crafting.resultInv.get(0)); },
    tick: () => { if (++n >= 10) { n = 0; book.maybeRebuild(); } return false; },
  };
};

export default Screens;
