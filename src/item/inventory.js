// ============================================================================
// inventory.js - Item stacks, inventories and the tooltip renderer.
//
// An "item stack" is a plain object so it survives structuredClone into
// IndexedDB without any custom (de)serialisation:
//
//   { item: 'diamond_sword', count: 1, damage: 0, ...extras }
//
// `null` always means "empty slot". Extras are the NBT-ish fields other
// modules attach: `enchants`, `customName`, `lore`, `potion`, `color`,
// `repairCost`, `items` (shulker box contents), `map`, `stewEffect`, ...
// Two stacks only merge when every one of those extras matches, which is what
// keeps a Sharpness V sword from stacking with a plain one.
//
// This module never touches the DOM or three.js, so tools/validate.mjs can
// import it in plain Node.
// ============================================================================
import {
  ARMOR_SLOT_NAMES, ARMOR_SLOTS, HOTBAR_SIZE, INV_MAIN_SIZE, blockId,
} from '../core/constants.js';
import { clamp, prettyName } from '../core/util.js';
import { Game } from '../core/game.js';
import { getItem, ITEM_NAMES, CREATIVE_TABS } from './items.js';
import { BLOCKS, blockByName } from '../world/blocks.js';
import {
  enchantmentTooltip, shouldConsumeDurability, vanishesOnDeath, isEnchanted,
} from './enchanting.js';
import { parsePotionItem, potionTooltipLines, potionDisplayName } from './brewing.js';
import { effectDisplayName, formatEffectTime, isHarmful } from './effects.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Total player slots: 36 main + 4 armour + 1 offhand. */
export const PLAYER_INV_SIZE = INV_MAIN_SIZE + ARMOR_SLOTS + 1;   // 41
/** First armour slot index in a PlayerInventory. */
export const ARMOR_SLOT_START = INV_MAIN_SIZE;                    // 36
/** The offhand slot index in a PlayerInventory. */
export const OFFHAND_SLOT = INV_MAIN_SIZE + ARMOR_SLOTS;          // 40
/** Vanilla hard cap on a stack, whatever an item definition claims. */
export const ABSOLUTE_MAX_STACK = 64;

/** Vanilla chat colours, reused by the tooltip builder. */
export const TEXT_COLORS = Object.freeze({
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa',
  dark_red: '#aa0000', dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa',
  dark_gray: '#555555', blue: '#5555ff', green: '#55ff55', aqua: '#55ffff',
  red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff',
});

/** Item name colour per rarity, matching the vanilla tooltip. */
export const RARITY_COLORS = Object.freeze({
  common: TEXT_COLORS.white,
  uncommon: TEXT_COLORS.yellow,
  rare: TEXT_COLORS.aqua,
  epic: TEXT_COLORS.light_purple,
});

// Armour slot -> the words vanilla puts in the attribute header.
const ARMOR_HEADER = ['When on Head:', 'When on Body:', 'When on Legs:', 'When on Feet:'];

// Fields that never take part in the "is this the same item" test.
const NON_NBT_KEYS = new Set(['count', 'item', 'damage', 'slot', 'index']);

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

const _warned = new Set();
function warnOnce(key, ...args) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn('[inventory]', ...args);
}

/** True for `{}` / `[]`, which compare equal to a missing field. */
function isEmptyContainer(v) {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const _k in v) return false;
    return true;
  }
  return false;
}

/**
 * Structured-clone-safe deep copy of plain data. Functions, symbols and class
 * instances are dropped rather than smuggled into IndexedDB.
 */
function clonePlain(v, depth = 0) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return undefined;
  if (depth > 6) return undefined;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      const c = clonePlain(v[i], depth + 1);
      out[i] = c === undefined ? null : c;
    }
    return out;
  }
  if (t !== 'object') return undefined;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out = {};
  for (const k of Object.keys(v)) {
    const c = clonePlain(v[k], depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Deep structural equality over plain data. */
function deepEq(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return false;
  if (ta !== 'object') return false;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq(a[k], b[k])) return false;
  }
  return true;
}

/**
 * The extra ("NBT") keys of a stack that participate in merging, sorted.
 * `enchantments` is skipped when `enchants` is present because enchanting.js
 * keeps the two as aliases of one object.
 */
function nbtKeys(s) {
  const out = [];
  for (const k of Object.keys(s)) {
    if (NON_NBT_KEYS.has(k)) continue;
    if (k === 'enchantments' && s.enchants) continue;
    const v = s[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    if (isEmptyContainer(v)) continue;
    if (k === 'displayName' && s.customName) continue;
    out.push(k);
  }
  out.sort();
  return out;
}

/** Item name for anything that identifies an item: a string, def or stack. */
function nameOf(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    if (typeof x.item === 'string') return x.item;
    if (typeof x.name === 'string') return x.name;
  }
  return null;
}

/** True when `owner` is playing in creative and should not consume anything. */
function ownerIsCreative(owner) {
  if (owner && typeof owner.gameMode === 'string') return owner.gameMode === 'creative';
  if (owner === null || owner === undefined) return false;
  return Game.mode === 'creative';
}

function playSoundAt(owner, name, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || !owner) return;
  try {
    if (a.playAt) a.playAt(name, owner.x, owner.y, owner.z, volume, pitch);
    else if (a.play) a.play(name, { volume, pitch, x: owner.x, y: owner.y, z: owner.z });
  } catch { /* audio is optional */ }
}

/** Trims a float for display: 7 -> "7", 1.6 -> "1.6", 0.10000001 -> "0.1". */
function fmtNum(v) {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

// ---------------------------------------------------------------------------
// Stack primitives
// ---------------------------------------------------------------------------

/**
 * Makes an item stack. `item` may be a name, an item definition or another
 * stack. `extra` is merged in for NBT-ish fields. Returns null for an empty
 * item or a non-positive count, so callers can use it directly in slots.
 */
export function stack(item, count = 1, extra = null) {
  const name = nameOf(item);
  if (!name || name === 'air') return null;
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = { item: name, count: n, damage: 0 };
  // Carry NBT across when the caller handed us a stack rather than a name.
  if (item && typeof item === 'object' && typeof item.item === 'string') {
    for (const k of Object.keys(item)) {
      if (k === 'item' || k === 'count') continue;
      const c = clonePlain(item[k]);
      if (c !== undefined) s[k] = c;
    }
    s.damage = Math.max(0, item.damage | 0);
  }
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) {
      if (k === 'item') continue;
      if (k === 'count') continue;
      const c = clonePlain(extra[k]);
      if (c !== undefined) s[k] = c;
    }
    if (s.enchants) s.enchantments = s.enchants;   // enchanting.js keeps them aliased
  }
  if (typeof s.damage !== 'number' || !Number.isFinite(s.damage) || s.damage < 0) s.damage = 0;
  return s;
}

/**
 * True when the slot holds nothing usable. A bare item name counts as
 * non-empty so a slot written by another module is never silently overwritten;
 * `Inventory.get()` upgrades it to a real stack on the next read.
 */
export function isEmpty(s) {
  if (!s) return true;
  if (typeof s === 'string') return s === 'air';
  return typeof s !== 'object' || typeof s.item !== 'string' || !s.item
    || s.item === 'air' || (s.count | 0) <= 0;
}

/** The inverse of isEmpty, exported because it reads better at call sites. */
export function isStack(s) { return !isEmpty(s); }

/** Item count of a slot, 0 when empty. */
export function stackCount(s) { return isEmpty(s) ? 0 : s.count | 0; }

/**
 * True when two stacks hold the very same thing - same item, same damage and
 * the same NBT-ish extras. Counts are ignored. Two empty slots match.
 */
export function sameItem(a, b) {
  const ea = isEmpty(a), eb = isEmpty(b);
  if (ea || eb) return ea && eb;
  if (a === b) return true;
  if (a.item !== b.item) return false;
  if ((a.damage | 0) !== (b.damage | 0)) return false;
  const ka = nbtKeys(a), kb = nbtKeys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k !== kb[i]) return false;
    if (!deepEq(a[k], b[k])) return false;
  }
  return true;
}

/** Same item ignoring damage and NBT - "is this broadly a diamond sword". */
export function sameItemType(a, b) {
  if (isEmpty(a) || isEmpty(b)) return false;
  return a.item === b.item;
}

/**
 * True when `b` can be stacked (at least partially) onto `a`. An empty slot on
 * either side accepts anything, which is what the slot-click code wants.
 */
export function canMerge(a, b) {
  if (isEmpty(a) || isEmpty(b)) return true;
  if (!sameItem(a, b)) return false;
  const max = maxStackSize(a);
  return max > 1 && (a.count | 0) < max;
}

/** How many items of `b` would actually fit onto `a` right now. */
export function mergeRoom(a, b) {
  if (isEmpty(b)) return 0;
  if (isEmpty(a)) return Math.min(b.count | 0, maxStackSize(b));
  if (!sameItem(a, b)) return 0;
  const max = maxStackSize(a);
  return Math.max(0, Math.min(max - (a.count | 0), b.count | 0));
}

/**
 * Pours `src` into `dst` in place. Returns how many items moved; `src.count`
 * is decremented by that amount. Both sides must already hold the same item -
 * an empty `dst` moves nothing, because there is no slot to write back to.
 */
export function mergeInto(dst, src) {
  if (isEmpty(dst) || isEmpty(src) || !sameItem(dst, src)) return 0;
  const n = mergeRoom(dst, src);
  if (n <= 0) return 0;
  dst.count = (dst.count | 0) + n;
  src.count = (src.count | 0) - n;
  return n;
}

/** Independent copy of a stack (or null). Nested NBT is deep-copied. */
export function copyStack(s) {
  if (isEmpty(s)) return null;
  const out = { item: s.item, count: s.count | 0, damage: Math.max(0, s.damage | 0) };
  for (const k of Object.keys(s)) {
    if (k === 'item' || k === 'count' || k === 'damage') continue;
    if (k === 'enchantments' && s.enchants) continue;
    const c = clonePlain(s[k]);
    if (c !== undefined) out[k] = c;
  }
  // Keep enchanting.js's alias pair intact.
  if (out.enchants) out.enchantments = out.enchants;
  return out;
}

/** Copy of `s` with a different count (null when count <= 0). */
export function withCount(s, count) {
  const n = Math.floor(Number(count));
  if (isEmpty(s) || !Number.isFinite(n) || n <= 0) return null;
  const c = copyStack(s);
  c.count = n;
  return c;
}

/**
 * Splits `n` items off `s`, mutating it. Returns the removed stack, or null
 * when nothing came off. `s` is left at count 0 when fully consumed - the
 * caller decides whether to null the slot.
 */
export function splitStack(s, n) {
  if (isEmpty(s)) return null;
  const take = Math.min(s.count | 0, Math.max(0, Math.floor(n)));
  if (take <= 0) return null;
  const out = withCount(s, take);
  s.count = (s.count | 0) - take;
  return out;
}

/** Max stack size for a stack or item name, clamped to 1..64. */
export function maxStackSize(s) {
  const name = nameOf(s);
  if (!name) return ABSOLUTE_MAX_STACK;
  const def = getItem(name);
  let n = def.stack | 0;
  if (!n) n = ABSOLUTE_MAX_STACK;
  if ((def.durability | 0) > 0) n = 1;
  if (s && typeof s === 'object' && s.maxStack) n = s.maxStack | 0;
  return clamp(n, 1, ABSOLUTE_MAX_STACK);
}

/** True when the stack is at its stack limit. */
export function isFull(s) {
  return !isEmpty(s) && (s.count | 0) >= maxStackSize(s);
}

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

/** Total durability of an item name / stack, 0 when it has none. */
export function itemDurability(s) {
  const name = nameOf(s);
  if (!name) return 0;
  return getItem(name).durability | 0;
}

/** True when the stack can take durability damage at all. */
export function isDamageable(s) {
  return !isEmpty(s) && itemDurability(s) > 0 && !s.unbreakable;
}

/** True when the stack has already lost durability. */
export function isDamaged(s) {
  return isDamageable(s) && (s.damage | 0) > 0;
}

/** Remaining uses before the item breaks. */
export function durabilityLeft(s) {
  const max = itemDurability(s);
  if (max <= 0) return 0;
  return Math.max(0, max - (isEmpty(s) ? 0 : s.damage | 0));
}

/** Remaining durability as 0..1 (1 for items without durability). */
export function durabilityFraction(s) {
  const max = itemDurability(s);
  if (max <= 0) return 1;
  return clamp(durabilityLeft(s) / max, 0, 1);
}

/**
 * Applies `amount` points of durability damage, rolling Unbreaking for each
 * point the way vanilla does (armour is protected 60 + 40/(lvl+1) percent of
 * the time, everything else 1/(lvl+1)).
 *
 * Returns the stack, or **null when it broke**. Creative owners never take
 * damage. When the owner carries the stack in an inventory, the broken stack
 * is cleared from it so callers that ignore the return value stay correct.
 */
export function damageStack(s, amount = 1, owner = null) {
  if (isEmpty(s)) return null;
  const max = itemDurability(s);
  if (max <= 0 || s.unbreakable) return s;
  if (ownerIsCreative(owner)) return s;

  let n = Math.floor(Number(amount));
  if (!Number.isFinite(n) || n <= 0) return s;

  const def = getItem(s.item);
  const isArmor = !!def.armor;
  const rng = owner && owner.rng && typeof owner.rng.next === 'function' ? owner.rng : null;
  let real = 0;
  for (let i = 0; i < n; i++) {
    if (shouldConsumeDurability(s, rng, isArmor)) real++;
  }
  if (real <= 0) return s;

  s.damage = (s.damage | 0) + real;
  if (s.damage < max) return s;

  // Broken.
  s.damage = max;
  s.count = 0;
  clearFromOwner(owner, s);
  playSoundAt(owner, 'item_break', 0.8, 0.9);
  return null;
}

/** Removes the exact stack object from an owner's inventory, if it is in one. */
function clearFromOwner(owner, s) {
  const inv = owner && owner.inventory;
  if (!inv || typeof inv.size !== 'number' || typeof inv.get !== 'function') return;
  for (let i = 0; i < inv.size; i++) {
    if (inv.get(i) === s) { inv.set(i, null); return; }
  }
  if (owner.equipment && typeof owner.equipment === 'object') {
    for (const k of Object.keys(owner.equipment)) {
      if (owner.equipment[k] === s) { owner.equipment[k] = null; return; }
    }
  }
}

/** Heals durability (anvil / grindstone / mending). Returns the stack. */
export function repairStack(s, amount) {
  if (isEmpty(s)) return s;
  const max = itemDurability(s);
  if (max <= 0) return s;
  s.damage = clamp((s.damage | 0) - Math.max(0, Math.floor(amount)), 0, max);
  return s;
}

// ---------------------------------------------------------------------------
// Display names, rarity and tooltips
// ---------------------------------------------------------------------------

/** Custom name a stack carries, or null. */
function customNameOf(s) {
  if (isEmpty(s)) return null;
  const c = s.customName || s.displayName;
  if (typeof c === 'string' && c.trim()) return c.trim();
  // `name` is only a custom name when it does not just repeat the item id.
  if (typeof s.name === 'string' && s.name.trim() && s.name !== s.item) return s.name.trim();
  return null;
}

/** Rarity of a stack: enchanting bumps common/uncommon one step, as in vanilla. */
export function stackRarity(s) {
  if (isEmpty(s)) return 'common';
  if (typeof s.rarity === 'string' && RARITY_COLORS[s.rarity]) return s.rarity;
  const def = getItem(s.item);
  let r = RARITY_COLORS[def.rarity] ? def.rarity : 'common';
  if (isEnchanted(s)) {
    if (r === 'common') r = 'uncommon';
    else if (r === 'uncommon') r = 'rare';
    else if (r === 'rare') r = 'epic';
  }
  return r;
}

/** Hex colour the item name is drawn in. */
export function rarityColor(rarity) {
  return RARITY_COLORS[rarity] || RARITY_COLORS.common;
}

/**
 * Human-readable name for a stack: custom name if it has one, otherwise the
 * item's display name, with potions resolved through brewing.js so a stack
 * whose `potion` field was swapped still reads correctly.
 */
export function stackDisplayName(s) {
  if (isEmpty(s)) return '';
  const custom = customNameOf(s);
  if (custom) return custom;

  const def = getItem(s.item);
  const parsed = parsePotionItem(s.item);
  if (parsed) {
    const id = typeof s.potion === 'string' && s.potion ? s.potion : parsed.potion;
    if (id !== parsed.potion || def.stub) return potionDisplayName(id, parsed.form);
    return def.display || potionDisplayName(id, parsed.form);
  }
  if (typeof s.potion === 'string' && s.potion && !def.potion) {
    return potionDisplayName(s.potion, 'potion');
  }
  return def.display || prettyName(s.item);
}

/** True when the F3+H style advanced tooltip should be shown. */
function advancedTooltipsOn() {
  if (Game.advancedTooltips !== undefined) return !!Game.advancedTooltips;
  const st = Game.settings;
  if (st && typeof st.get === 'function') {
    const v = st.get('advancedTooltips');
    if (typeof v === 'boolean') return v;
  }
  return false;
}

/** Effect lines for an item that carries `food.effects` or `stack.effects`. */
function effectLines(entries) {
  const out = [];
  for (const e of entries) {
    if (!e) continue;
    let name = null, ticks = 0, level = 0;
    if (Array.isArray(e)) { name = e[0]; ticks = e[1] | 0; level = e[2] | 0; }
    else if (typeof e === 'string') { name = e; ticks = 600; }
    else { name = e.effect || e.name; ticks = (e.ticks ?? e.duration) | 0; level = (e.level ?? e.amplifier) | 0; }
    if (!name) continue;
    const label = effectDisplayName(name, level);
    const text = ticks > 1 ? `${label} (${formatEffectTime(ticks)})` : label;
    out.push({ text, color: isHarmful(name) ? TEXT_COLORS.red : TEXT_COLORS.green });
  }
  return out;
}

/**
 * Builds the vanilla-shaped tooltip for a stack as `[{ text, color }]`.
 * Order: name, potion effects, enchantments, lore, attribute blocks,
 * "Unbreakable", durability, and - with advanced tooltips on - the item id.
 *
 * `opts.advanced` overrides the global advanced-tooltip flag.
 */
export function stackTooltipLines(s, opts = {}) {
  if (isEmpty(s)) return [];
  const advanced = opts.advanced !== undefined ? !!opts.advanced : advancedTooltipsOn();
  const def = getItem(s.item);
  const lines = [];
  const push = (text, color, extra) => {
    const line = { text, color };
    if (extra) Object.assign(line, extra);
    lines.push(line);
  };
  const blank = () => { if (lines.length) push('', null); };

  // --- 1. name -------------------------------------------------------------
  const custom = customNameOf(s);
  push(stackDisplayName(s), rarityColor(stackRarity(s)), custom ? { italic: true } : null);

  // --- 2. potion effects ---------------------------------------------------
  const parsed = parsePotionItem(s.item);
  if (parsed) {
    const id = typeof s.potion === 'string' && s.potion ? s.potion : parsed.potion;
    for (const l of potionTooltipLines(id, parsed.form)) lines.push({ text: l.text, color: l.color });
  } else if (Array.isArray(s.effects) && s.effects.length) {
    for (const l of effectLines(s.effects)) lines.push(l);
  } else if (s.stewEffect) {
    for (const l of effectLines([s.stewEffect])) lines.push(l);
  }

  // --- 3. enchantments -----------------------------------------------------
  for (const l of enchantmentTooltip(s)) lines.push({ text: l.text, color: l.color });

  // --- 4. written books / discs / maps -------------------------------------
  if (typeof s.author === 'string' && s.author) push(`by ${s.author}`, TEXT_COLORS.gray);
  if (def.music && Array.isArray(def.tags) && def.tags.length) push(def.tags[0], TEXT_COLORS.gray);
  if (s.map && typeof s.map === 'object' && s.map.id !== undefined) {
    push(`Map #${s.map.id}`, TEXT_COLORS.gray);
  }

  // --- 5. container preview (shulker boxes, bundles) ------------------------
  const held = Array.isArray(s.items) ? s.items : null;
  if (held && held.length) {
    let shown = 0;
    for (const inner of held) {
      if (isEmpty(inner)) continue;
      if (shown >= 5) break;
      push(`${stackDisplayName(inner)} x${inner.count | 0}`, TEXT_COLORS.gray);
      shown++;
    }
    let more = 0;
    for (const inner of held) if (!isEmpty(inner)) more++;
    if (more > shown) push(`and ${more - shown} more...`, TEXT_COLORS.gray, { italic: true });
  }

  // --- 6. lore -------------------------------------------------------------
  const lore = Array.isArray(s.lore) ? s.lore : (typeof s.lore === 'string' ? [s.lore] : null);
  if (lore) for (const l of lore) push(String(l), TEXT_COLORS.dark_purple, { italic: true });

  // --- 7. attribute modifiers ---------------------------------------------
  const tool = def.tool;
  if (tool && (tool.damage || tool.attackSpeed)) {
    blank();
    push('When in Main Hand:', TEXT_COLORS.gray);
    if (tool.damage) push(` ${fmtNum(tool.damage)} Attack Damage`, TEXT_COLORS.dark_green);
    if (tool.attackSpeed) push(` ${fmtNum(tool.attackSpeed)} Attack Speed`, TEXT_COLORS.dark_green);
  }
  const armor = def.armor;
  if (armor && armor.index >= 0 && armor.index < ARMOR_HEADER.length) {
    blank();
    push(ARMOR_HEADER[armor.index], TEXT_COLORS.gray);
    if (armor.defense) push(` +${fmtNum(armor.defense)} Armor`, TEXT_COLORS.dark_green);
    if (armor.toughness) push(` +${fmtNum(armor.toughness)} Armor Toughness`, TEXT_COLORS.dark_green);
    if (armor.knockbackResist) {
      push(` +${fmtNum(armor.knockbackResist)} Knockback Resistance`, TEXT_COLORS.dark_green);
    }
  } else if (armor && armor.slot === 'horse' && armor.defense) {
    blank();
    push('When on Body:', TEXT_COLORS.gray);
    push(` +${fmtNum(armor.defense)} Armor`, TEXT_COLORS.dark_green);
  }

  // --- 8. flags and durability --------------------------------------------
  if (s.unbreakable) push('Unbreakable', TEXT_COLORS.blue);
  const max = itemDurability(s);
  if (max > 0 && (s.damage | 0) > 0 && !s.unbreakable) {
    push(`Durability: ${durabilityLeft(s)} / ${max}`, TEXT_COLORS.white);
  }

  // --- 9. advanced ---------------------------------------------------------
  if (advanced) {
    push(s.item, TEXT_COLORS.dark_gray);
    const n = nbtKeys(s).length;
    if (n > 0) push(`NBT: ${n} tag${n === 1 ? '' : 's'}`, TEXT_COLORS.dark_gray);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

// Cheap stand-ins for the common item tags, used when an item definition does
// not carry an explicit `tags` array. Deliberately private to this module.
const TAG_TESTS = {
  planks: (n) => n.endsWith('_planks'),
  logs: (n) => /(_log|_wood|_stem|_hyphae)$/.test(n),
  wool: (n) => n.endsWith('_wool'),
  carpets: (n) => n.endsWith('_carpet'),
  beds: (n) => n.endsWith('_bed'),
  banners: (n) => n.endsWith('_banner'),
  saplings: (n) => n.endsWith('_sapling'),
  leaves: (n) => n.endsWith('_leaves'),
  flowers: (n) => /(_tulip|_orchid|dandelion|poppy|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|peony|rose_bush)$/.test(n),
  stone_tool_materials: (n) => n === 'cobblestone' || n === 'blackstone' || n === 'cobbled_deepslate',
  coals: (n) => n === 'coal' || n === 'charcoal',
  wooden_slabs: (n) => n.endsWith('_slab') && !/(stone|brick|quartz|purpur|sandstone|prismarine|copper|deepslate|blackstone|basalt|tuff|mud)/.test(n),
  swords: (n) => n.endsWith('_sword'),
  pickaxes: (n) => n.endsWith('_pickaxe'),
  axes: (n) => n.endsWith('_axe'),
  shovels: (n) => n.endsWith('_shovel'),
  hoes: (n) => n.endsWith('_hoe'),
  music_discs: (n) => n.startsWith('music_disc_'),
  arrows: (n) => n === 'arrow' || n === 'spectral_arrow' || n.startsWith('tipped_arrow'),
  fish: (n) => n === 'cod' || n === 'salmon' || n === 'tropical_fish' || n === 'pufferfish',
  boats: (n) => n.endsWith('_boat') || n.endsWith('_chest_boat'),
  dyes: (n) => n.endsWith('_dye'),
  candles: (n) => n === 'candle' || n.endsWith('_candle'),
};

/** True when the item carries `tag` (with or without the leading '#'). */
function itemHasTag(name, tag) {
  const t = tag.charAt(0) === '#' ? tag.slice(1) : tag;
  const def = getItem(name);
  if (Array.isArray(def.tags)) {
    for (const x of def.tags) {
      if (typeof x !== 'string') continue;
      if (x === t || x === '#' + t) return true;
    }
  }
  const fn = TAG_TESTS[t];
  return fn ? fn(name) : false;
}

/**
 * Generic stack predicate used by shift-click, hoppers and container slots.
 *
 * `filter` may be:
 *   null / undefined     - everything matches
 *   function(stack)      - custom predicate
 *   'stone'              - exact item name
 *   '#planks'            - item tag
 *   ['a', 'b', '#logs']  - any of
 *   Set                  - membership by item name
 *   RegExp               - tested against the item name
 *   { item, items, tag, group, tab, tool, kind, tier, food, armor, block, fuel,
 *     rarity, enchanted, damaged, potion, exclude, test, minCount }
 */
export function stackMatchesFilter(s, filter) {
  if (filter === null || filter === undefined) return !isEmpty(s);
  if (isEmpty(s)) return false;

  if (typeof filter === 'function') { try { return !!filter(s); } catch { return false; } }
  if (typeof filter === 'string') {
    if (filter.charAt(0) === '#') return itemHasTag(s.item, filter);
    return s.item === filter;
  }
  if (filter instanceof RegExp) return filter.test(s.item);
  if (filter instanceof Set) return filter.has(s.item);
  if (Array.isArray(filter)) {
    for (const f of filter) if (stackMatchesFilter(s, f)) return true;
    return false;
  }
  if (typeof filter !== 'object') return false;

  const def = getItem(s.item);
  if (filter.item !== undefined && !stackMatchesFilter(s, filter.item)) return false;
  if (filter.items !== undefined && !stackMatchesFilter(s, filter.items)) return false;
  if (filter.tag !== undefined && !itemHasTag(s.item, String(filter.tag))) return false;
  if (filter.group !== undefined && def.group !== filter.group) return false;
  if (filter.tab !== undefined && def.tab !== filter.tab) return false;
  if (filter.tool !== undefined) {
    if (filter.tool === true) { if (!def.tool) return false; }
    else if (filter.tool === false) { if (def.tool) return false; }
    else if (!def.tool || def.tool.kind !== filter.tool) return false;
  }
  if (filter.kind !== undefined && (!def.tool || def.tool.kind !== filter.kind)) return false;
  if (filter.tier !== undefined && (!def.tool || (def.tool.tier | 0) < (filter.tier | 0))) return false;
  if (filter.food !== undefined && !!def.food !== !!filter.food) return false;
  if (filter.armor !== undefined) {
    if (typeof filter.armor === 'string') { if (!def.armor || def.armor.slot !== filter.armor) return false; }
    else if (!!def.armor !== !!filter.armor) return false;
  }
  if (filter.block !== undefined) {
    if (filter.block === true) { if (!def.block) return false; }
    else if (filter.block === false) { if (def.block) return false; }
    else if (def.block !== filter.block) return false;
  }
  if (filter.fuel !== undefined && !!(def.fuel | 0) !== !!filter.fuel) return false;
  if (filter.rarity !== undefined && stackRarity(s) !== filter.rarity) return false;
  if (filter.enchanted !== undefined && isEnchanted(s) !== !!filter.enchanted) return false;
  if (filter.damaged !== undefined && isDamaged(s) !== !!filter.damaged) return false;
  if (filter.damageable !== undefined && isDamageable(s) !== !!filter.damageable) return false;
  if (filter.potion !== undefined) {
    const p = parsePotionItem(s.item);
    if (filter.potion === true) { if (!p) return false; }
    else if (!p || (typeof s.potion === 'string' ? s.potion : p.potion) !== filter.potion) return false;
  }
  if (filter.minCount !== undefined && (s.count | 0) < (filter.minCount | 0)) return false;
  if (filter.exclude !== undefined && stackMatchesFilter(s, filter.exclude)) return false;
  if (typeof filter.test === 'function') { try { if (!filter.test(s)) return false; } catch { return false; } }
  return true;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * A flat array of item slots with vanilla merge semantics. Every mutation runs
 * through set()/markChanged() so UIs can hang off the `onChange` callback.
 */
export class Inventory {
  constructor(size, name = '') {
    /** @type {number} */
    this.size = Math.max(0, size | 0);
    /** @type {Array<object|null>} */
    this.slots = new Array(this.size).fill(null);
    /** @type {string} */
    this.name = name || '';
    /** @type {((index:number, stack:object|null, inv:Inventory)=>void)|null} */
    this.onChange = null;
    /** Bumped on every change; cheap for UIs to poll. */
    this.version = 0;
  }

  // ---- reads --------------------------------------------------------------

  /**
   * Stack in slot `i`, or null. Out-of-range reads are null, never a throw.
   * A slot holding a bare item name (some block entities write those) is
   * upgraded to a real stack in place, so containers stay well-formed.
   */
  get(i) {
    if (i < 0 || i >= this.size) return null;
    const s = this.slots[i];
    if (typeof s === 'string') {
      const fixed = stack(s, 1);
      this.slots[i] = fixed;
      return fixed;
    }
    return isEmpty(s) ? null : s;
  }

  /** Item name in slot `i`, or null. */
  itemAt(i) {
    const s = this.get(i);
    return s ? s.item : null;
  }

  /** Index of the first empty slot, or -1. */
  firstEmpty() {
    for (let i = 0; i < this.size; i++) if (isEmpty(this.slots[i])) return i;
    return -1;
  }

  /** Index of the first slot matching `pred(stack, index)`, or -1. */
  firstMatching(pred) {
    const fn = typeof pred === 'function' ? pred : (s) => stackMatchesFilter(s, pred);
    for (let i = 0; i < this.size; i++) {
      const s = this.get(i);
      if (s && fn(s, i)) return i;
    }
    return -1;
  }

  /** Every slot matching a filter, as indices. */
  allMatching(filter) {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const s = this.get(i);
      if (s && stackMatchesFilter(s, filter)) out.push(i);
    }
    return out;
  }

  /** Total item count for a name / filter. */
  count(nameOrFilter) {
    let total = 0;
    const isName = typeof nameOrFilter === 'string' && nameOrFilter.charAt(0) !== '#';
    for (let i = 0; i < this.size; i++) {
      const s = this.get(i);
      if (!s) continue;
      if (isName ? s.item === nameOrFilter : stackMatchesFilter(s, nameOrFilter)) total += s.count | 0;
    }
    return total;
  }

  /** True when at least `count` of the item are present. */
  has(nameOrFilter, count = 1) {
    return this.count(nameOrFilter) >= (count | 0);
  }

  /** True when every slot is empty. */
  isEmpty() {
    for (let i = 0; i < this.size; i++) if (!isEmpty(this.slots[i])) return false;
    return true;
  }

  /** How many slots hold something. */
  usedSlots() {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (!isEmpty(this.slots[i])) n++;
    return n;
  }

  /** True when nothing more can be added without displacing something. */
  isFull() {
    return this.firstEmpty() < 0;
  }

  /** Live array of the non-empty stacks (not copies). */
  contents() {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const s = this.get(i);
      if (s) out.push(s);
    }
    return out;
  }

  /** Iterates non-empty slots as fn(stack, index). */
  forEach(fn) {
    for (let i = 0; i < this.size; i++) {
      const s = this.get(i);
      if (s) fn(s, i);
    }
  }

  // ---- writes -------------------------------------------------------------

  /** Notifies listeners. `index` is -1 for bulk changes. */
  markChanged(index = -1) {
    this.version++;
    if (this.onChange) {
      try { this.onChange(index, index >= 0 ? this.get(index) : null, this); }
      catch (e) { warnOnce('onChange', 'inventory onChange handler threw', e); }
    }
  }

  /**
   * Puts a stack in a slot. Empty or zero-count stacks become null. Returns
   * the stack that is now in the slot.
   */
  set(i, s) {
    if (i < 0 || i >= this.size) return null;
    if (typeof s === 'string') s = stack(s, 1);
    const v = isEmpty(s) ? null : s;
    if (this.slots[i] === v) {
      // Writing the same object back is how callers say "I mutated the count",
      // so still notify - but a null-over-null write is a genuine no-op.
      if (v !== null) this.markChanged(i);
      return v;
    }
    if (v && !this.canAccept(i, v)) return this.get(i);
    this.slots[i] = v;
    this.markChanged(i);
    return v;
  }

  /**
   * Slot-level restriction hook. The base inventory takes anything; armour
   * slots and container slots override it.
   */
  // eslint-disable-next-line no-unused-vars
  canAccept(i, s) { return i >= 0 && i < this.size; }

  /**
   * Adds a stack, merging into partial stacks first and then filling empty
   * slots. The input stack is not mutated. Returns the leftover as a new
   * stack, or null when everything fit.
   */
  add(s) {
    return this.addRange(s, 0, this.size);
  }

  /** add() restricted to `[from, to)`. */
  addRange(s, from, to) {
    if (isEmpty(s)) return null;
    const work = copyStack(s);
    const lo = Math.max(0, from | 0), hi = Math.min(this.size, to | 0);
    const max = maxStackSize(work);

    if (max > 1) {
      for (let i = lo; i < hi && work.count > 0; i++) {
        const cur = this.get(i);
        if (!cur || !sameItem(cur, work)) continue;
        if (mergeInto(cur, work) > 0) this.markChanged(i);
      }
    }
    for (let i = lo; i < hi && work.count > 0; i++) {
      if (!isEmpty(this.slots[i])) continue;
      if (!this.canAccept(i, work)) continue;
      const put = Math.min(work.count, max);
      this.slots[i] = withCount(work, put);
      work.count -= put;
      this.markChanged(i);
    }
    return work.count > 0 ? work : null;
  }

  /**
   * Adds as much of `s` as slot `i` will take. Returns the leftover (a new
   * stack) or null.
   */
  addTo(i, s) {
    if (isEmpty(s)) return null;
    if (i < 0 || i >= this.size) return copyStack(s);
    const work = copyStack(s);
    if (!this.canAccept(i, work)) return work;
    const cur = this.get(i);
    if (!cur) {
      const put = Math.min(work.count, maxStackSize(work));
      this.slots[i] = withCount(work, put);
      work.count -= put;
      this.markChanged(i);
      return work.count > 0 ? work : null;
    }
    if (!sameItem(cur, work)) return work;
    if (mergeInto(cur, work) > 0) this.markChanged(i);
    return work.count > 0 ? work : null;
  }

  /**
   * Takes up to `count` items out of slot `i`. Returns the removed stack, or
   * null. `count` defaults to the whole stack.
   */
  remove(i, count = Infinity) {
    const cur = this.get(i);
    if (!cur) return null;
    const n = count === Infinity ? cur.count | 0 : Math.max(0, Math.floor(count));
    if (n <= 0) return null;
    if (n >= (cur.count | 0)) {
      this.slots[i] = null;
      this.markChanged(i);
      return cur;
    }
    const out = splitStack(cur, n);
    this.markChanged(i);
    return out;
  }

  /** Empties slot `i` and returns whatever was in it. */
  take(i) { return this.remove(i, Infinity); }

  /**
   * Removes up to `count` of an item (or filter) from anywhere in the
   * inventory. Returns how many were actually removed.
   */
  removeItem(nameOrFilter, count = 1) {
    let want = Math.max(0, Math.floor(count));
    if (want <= 0) return 0;
    let removed = 0;
    const isName = typeof nameOrFilter === 'string' && nameOrFilter.charAt(0) !== '#';
    for (let i = 0; i < this.size && want > 0; i++) {
      const s = this.get(i);
      if (!s) continue;
      if (isName ? s.item !== nameOrFilter : !stackMatchesFilter(s, nameOrFilter)) continue;
      const take = Math.min(want, s.count | 0);
      s.count -= take;
      want -= take;
      removed += take;
      if (s.count <= 0) this.slots[i] = null;
      this.markChanged(i);
    }
    return removed;
  }

  /** Swaps two slots. Returns true when anything moved. */
  swap(a, b) {
    if (a === b || a < 0 || b < 0 || a >= this.size || b >= this.size) return false;
    const sa = this.slots[a], sb = this.slots[b];
    if (sa === sb) return false;
    this.slots[a] = isEmpty(sb) ? null : sb;
    this.slots[b] = isEmpty(sa) ? null : sa;
    this.markChanged(a);
    this.markChanged(b);
    return true;
  }

  /** Splits slot `i` in half, returning the half that came off. */
  splitSlot(i) {
    const cur = this.get(i);
    if (!cur) return null;
    return this.remove(i, Math.ceil((cur.count | 0) / 2));
  }

  /** Merges duplicate stacks together, leaving holes where stacks emptied. */
  compact() {
    let changed = false;
    for (let i = 0; i < this.size; i++) {
      const a = this.get(i);
      if (!a || maxStackSize(a) <= 1) continue;
      for (let j = i + 1; j < this.size && (a.count | 0) < maxStackSize(a); j++) {
        const b = this.get(j);
        if (!b || !sameItem(a, b)) continue;
        if (mergeInto(a, b) > 0) {
          changed = true;
          if (b.count <= 0) this.slots[j] = null;
        }
      }
    }
    if (changed) this.markChanged(-1);
    return changed;
  }

  /** Empties every slot. */
  clear() {
    let changed = false;
    for (let i = 0; i < this.size; i++) {
      if (this.slots[i] !== null) { this.slots[i] = null; changed = true; }
    }
    if (changed) this.markChanged(-1);
    return changed;
  }

  /** Replaces the whole slot array from an iterable of stacks. */
  fill(stacks) {
    for (let i = 0; i < this.size; i++) {
      const s = stacks && stacks[i];
      this.slots[i] = isEmpty(s) ? null : sanitizeStack(s);
    }
    this.markChanged(-1);
    return this;
  }

  /** Which slots sortInventory() is allowed to touch, as [from, to). */
  sortRange() { return [0, this.size]; }

  // ---- persistence --------------------------------------------------------

  /** Structured-clone-safe snapshot for save.js. */
  serialize() {
    const slots = new Array(this.size);
    for (let i = 0; i < this.size; i++) slots[i] = copyStack(this.slots[i]);
    return { size: this.size, name: this.name, slots };
  }

  /** Restores from serialize() output, a bare slot array, or a save record. */
  load(data) {
    if (!data) return this;
    const arr = Array.isArray(data) ? data : (Array.isArray(data.slots) ? data.slots : null);
    if (!arr) return this;
    if (!Array.isArray(data) && typeof data.name === 'string' && data.name) this.name = data.name;
    for (let i = 0; i < this.size; i++) {
      this.slots[i] = i < arr.length ? sanitizeStack(arr[i]) : null;
    }
    this.markChanged(-1);
    return this;
  }

  /** A detached copy of this inventory (same class, same contents). */
  copy() {
    const out = new Inventory(this.size, this.name);
    for (let i = 0; i < this.size; i++) out.slots[i] = copyStack(this.slots[i]);
    return out;
  }
}

/**
 * Turns loosely-shaped saved data ('stone', {item,count}, ...) into a valid
 * stack, or null. Unknown item names survive - items.js stubs them rather than
 * throwing, so a save from an older build still loads.
 */
export function sanitizeStack(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return stack(raw, 1);
  if (typeof raw !== 'object') return null;
  const name = typeof raw.item === 'string' ? raw.item : (typeof raw.name === 'string' ? raw.name : null);
  if (!name || name === 'air') return null;
  const count = Math.floor(Number(raw.count));
  const s = stack(name, Number.isFinite(count) && count > 0 ? count : 1);
  if (!s) return null;
  for (const k of Object.keys(raw)) {
    if (k === 'item' || k === 'count') continue;
    const c = clonePlain(raw[k]);
    if (c !== undefined) s[k] = c;
  }
  s.damage = Math.max(0, Math.floor(Number(raw.damage)) || 0);
  const max = itemDurability(s);
  if (max > 0 && s.damage > max) s.damage = max;
  if (s.enchants) s.enchantments = s.enchants;
  return s;
}

// ---------------------------------------------------------------------------
// PlayerInventory
// ---------------------------------------------------------------------------

// Blocks with no item of their own that vanilla still lets you pick.
const PICK_OVERRIDES = { water: 'water_bucket', lava: 'lava_bucket', powder_snow: 'powder_snow_bucket' };

// blockName -> the item that actually places it. Built on first pick-block so
// crops hand out their seed item rather than their harvest item.
let _placerByBlock = null;
function placerItemFor(blockName) {
  if (!_placerByBlock) {
    _placerByBlock = new Map();
    for (const name of ITEM_NAMES) {
      const def = getItem(name);
      const b = def.block;
      if (!b) continue;
      // An item named exactly after its block always wins the slot.
      if (!_placerByBlock.has(b) || name === b) _placerByBlock.set(b, name);
    }
  }
  return _placerByBlock.get(blockName) || null;
}

/** Item name a block should hand you when pick-blocked. */
function blockPickItem(blockOrId) {
  let def = null;
  if (typeof blockOrId === 'number') {
    // Accepts a bare id or a packed id|meta value.
    def = BLOCKS[blockId(blockOrId)] || null;
  } else if (typeof blockOrId === 'string') {
    def = blockByName(blockOrId) || null;
    if (!def) return blockOrId;             // already an item name
  } else if (blockOrId && typeof blockOrId === 'object') {
    if (typeof blockOrId.item === 'string') return blockOrId.item;
    if (typeof blockOrId.name === 'string') return blockOrId.name;
    if (typeof blockOrId.id === 'number') def = BLOCKS[blockId(blockOrId.id)] || null;
  }
  if (!def || def.air) return null;
  // 1. an explicit itemName on the block definition (carrots -> carrot)
  if (def.itemName && !getItem(def.itemName).stub) return def.itemName;
  // 2. whatever item actually places this block (wheat -> wheat_seeds)
  const placer = placerItemFor(def.name);
  if (placer) return placer;
  // 3. an item that simply shares the block's name
  if (!getItem(def.name).stub) return def.name;
  // 4. the handful of blocks you pick as a bucket
  const over = PICK_OVERRIDES[def.name];
  return over && !getItem(over).stub ? over : null;
}

/**
 * The player's 41 slots plus the 2x2 crafting grid.
 *
 *   0..8    hotbar
 *   9..35   backpack
 *   36..39  armour: head, chest, legs, feet
 *   40      offhand
 */
export class PlayerInventory extends Inventory {
  constructor(name = 'Inventory') {
    super(PLAYER_INV_SIZE, name);
    /** Selected hotbar slot, 0..8. */
    this.selected = 0;
    /** The 2x2 player crafting grid. */
    this.crafting = new Inventory(4, 'crafting');
    /** The single crafting output slot. */
    this.craftResult = new Inventory(1, 'crafting_result');
    /** What the cursor is dragging in an open screen (screens.js owns this). */
    this.cursor = null;
  }

  // ---- hotbar -------------------------------------------------------------

  /** The stack in the selected hotbar slot, or null. */
  getSelected() { return this.get(this.selected); }

  /** Alias used by player.js / combat code. */
  getHeld() { return this.get(this.selected); }

  /** Replaces the selected hotbar slot. */
  setSelected(s) { return this.set(this.selected, s); }

  /** Moves the hotbar cursor, wrapping around. */
  selectSlot(i) {
    const n = HOTBAR_SIZE;
    this.selected = ((i % n) + n) % n;
    this.markChanged(this.selected);
    return this.selected;
  }

  /** Scrolls the hotbar by `d` slots. */
  scrollHotbar(d) { return this.selectSlot(this.selected + (d | 0)); }

  // ---- armour and offhand -------------------------------------------------

  /** Armour slot index for 0..3 or 'head'|'chest'|'legs'|'feet'. */
  static armorIndex(slot) {
    if (typeof slot === 'number') return clamp(slot | 0, 0, ARMOR_SLOTS - 1);
    const i = ARMOR_SLOT_NAMES.indexOf(String(slot));
    return i < 0 ? 0 : i;
  }

  /** Armour piece in a slot (0 head .. 3 feet). */
  getArmor(slot) { return this.get(ARMOR_SLOT_START + PlayerInventory.armorIndex(slot)); }

  /** Puts an armour piece in a slot. Returns what is in the slot afterwards. */
  setArmor(slot, s) { return this.set(ARMOR_SLOT_START + PlayerInventory.armorIndex(slot), s); }

  /** All four armour slots, head first (nulls included). */
  armorStacks() {
    const out = new Array(ARMOR_SLOTS);
    for (let i = 0; i < ARMOR_SLOTS; i++) out[i] = this.get(ARMOR_SLOT_START + i);
    return out;
  }

  /** The offhand stack, or null. */
  getOffhand() { return this.get(OFFHAND_SLOT); }

  /** Replaces the offhand stack. */
  setOffhand(s) { return this.set(OFFHAND_SLOT, s); }

  /** Sum of armour defense points across the four armour slots. */
  armorPoints() {
    let n = 0;
    for (let i = 0; i < ARMOR_SLOTS; i++) {
      const s = this.get(ARMOR_SLOT_START + i);
      if (!s) continue;
      const a = getItem(s.item).armor;
      if (a) n += a.defense || 0;
    }
    return n;
  }

  /** Sum of armour toughness. */
  armorToughness() {
    let n = 0;
    for (let i = 0; i < ARMOR_SLOTS; i++) {
      const s = this.get(ARMOR_SLOT_START + i);
      if (!s) continue;
      const a = getItem(s.item).armor;
      if (a) n += a.toughness || 0;
    }
    return n;
  }

  /** Sum of armour knockback resistance (netherite). */
  armorKnockbackResistance() {
    let n = 0;
    for (let i = 0; i < ARMOR_SLOTS; i++) {
      const s = this.get(ARMOR_SLOT_START + i);
      if (!s) continue;
      const a = getItem(s.item).armor;
      if (a) n += a.knockbackResist || 0;
    }
    return n;
  }

  /** Armour slots only accept armour of the right kind; offhand takes anything. */
  canAccept(i, s) {
    if (i < 0 || i >= this.size) return false;
    if (i < ARMOR_SLOT_START || i > OFFHAND_SLOT) return true;
    if (i === OFFHAND_SLOT) return true;
    if (isEmpty(s)) return true;
    const slot = i - ARMOR_SLOT_START;
    // Pumpkins and mob heads go on your head even though they are not armour.
    if (slot === 0 && (s.item === 'carved_pumpkin' || /(_head|_skull)$/.test(s.item))) return true;
    const a = getItem(s.item).armor;
    if (!a) return false;
    return a.index === slot;
  }

  // ---- adding -------------------------------------------------------------

  /**
   * Adds to the main 36 slots only - armour and the offhand are never filled
   * automatically. The selected slot is tried first when it can take the item,
   * matching vanilla's "picked-up items land in your hand" behaviour.
   */
  add(s) {
    if (isEmpty(s)) return null;
    let work = copyStack(s);
    const sel = this.get(this.selected);
    if (sel && sameItem(sel, work) && maxStackSize(work) > 1) {
      if (mergeInto(sel, work) > 0) this.markChanged(this.selected);
      if (work.count <= 0) return null;
    }
    work = this.addRange(work, 0, INV_MAIN_SIZE);
    return work;
  }

  /** Only the storage rows take part in sorting. */
  sortRange() { return [HOTBAR_SIZE, INV_MAIN_SIZE]; }

  // ---- pick block ---------------------------------------------------------

  /**
   * Middle-click behaviour. `blockId` may be a numeric block id, a block name,
   * an item name or a stack.
   *
   * - already in hand            -> nothing to do
   * - in the hotbar              -> select that slot
   * - in the backpack            -> swap it into the selected hotbar slot
   * - creative and not carried   -> conjure a stack into a free hotbar slot
   *
   * Returns true when the player now holds the item.
   */
  pickBlock(blockId, creative = null) {
    const name = blockPickItem(blockId);
    if (!name) return false;
    const isCreative = creative === null ? Game.mode === 'creative' : !!creative;

    const held = this.get(this.selected);
    if (held && held.item === name) return true;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = this.get(i);
      if (s && s.item === name) { this.selectSlot(i); return true; }
    }
    for (let i = HOTBAR_SIZE; i < INV_MAIN_SIZE; i++) {
      const s = this.get(i);
      if (s && s.item === name) { this.swap(i, this.selected); return true; }
    }
    if (!isCreative) return false;

    const fresh = stack(name, 1);
    if (!fresh) return false;
    // Prefer an empty hotbar slot so nothing already carried gets displaced.
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (isEmpty(this.slots[i])) { this.set(i, fresh); this.selectSlot(i); return true; }
    }
    // Otherwise push whatever is in hand into the backpack and take the slot.
    if (held) {
      const spare = this.firstEmptyIn(HOTBAR_SIZE, INV_MAIN_SIZE);
      if (spare >= 0) this.set(spare, held);
    }
    this.set(this.selected, fresh);
    return true;
  }

  /** First empty slot inside `[from, to)`, or -1. */
  firstEmptyIn(from, to) {
    const lo = Math.max(0, from | 0), hi = Math.min(this.size, to | 0);
    for (let i = lo; i < hi; i++) if (isEmpty(this.slots[i])) return i;
    return -1;
  }

  /** Total slots free in the main 36 (armour and offhand excluded). */
  freeSlots() {
    let n = 0;
    for (let i = 0; i < INV_MAIN_SIZE; i++) if (isEmpty(this.slots[i])) n++;
    return n;
  }

  /** Everything that should drop on death: main slots, armour, offhand, grid. */
  dropContents() {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const s = this.get(i);
      if (!s) continue;
      if (vanishesOnDeath(s)) { this.slots[i] = null; continue; }
      out.push(s);
      this.slots[i] = null;
    }
    for (let i = 0; i < this.crafting.size; i++) {
      const s = this.crafting.get(i);
      if (s) out.push(s);
      this.crafting.slots[i] = null;
    }
    this.craftResult.slots[0] = null;
    if (this.cursor) { out.push(this.cursor); this.cursor = null; }
    this.markChanged(-1);
    this.crafting.markChanged(-1);
    return out;
  }

  // ---- persistence --------------------------------------------------------

  serialize() {
    const d = super.serialize();
    d.selected = this.selected;
    d.crafting = this.crafting.serialize();
    if (this.cursor) d.cursor = copyStack(this.cursor);
    return d;
  }

  load(data) {
    super.load(data);
    if (data && !Array.isArray(data)) {
      if (typeof data.selected === 'number' && Number.isFinite(data.selected)) {
        this.selected = clamp(data.selected | 0, 0, HOTBAR_SIZE - 1);
      }
      if (data.crafting) this.crafting.load(data.crafting);
      this.cursor = data.cursor ? sanitizeStack(data.cursor) : null;
    }
    return this;
  }

  copy() {
    const out = new PlayerInventory(this.name);
    for (let i = 0; i < this.size; i++) out.slots[i] = copyStack(this.slots[i]);
    out.selected = this.selected;
    for (let i = 0; i < this.crafting.size; i++) out.crafting.slots[i] = copyStack(this.crafting.slots[i]);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/**
 * A block container (chest, furnace, hopper, dispenser, ...) whose slots live
 * on the block entity so world saving picks them up for free. Writing through
 * the container mutates `be.slots` directly; there is no second copy to keep
 * in sync.
 */
export class Container extends Inventory {
  constructor(size = 27, name = '', be = null, world = null, x = 0, y = 0, z = 0) {
    super(size, name);
    // super() assigned through the `slots` setter below, which - with _be still
    // undefined - parked the fresh array in _ownSlots. attach() moves it over.
    /** @type {object|null} the backing block entity record */
    this._be = null;
    /** @type {import('../world/world.js').World|null} */
    this.world = world || null;
    this.x = x | 0; this.y = y | 0; this.z = z | 0;
    /** Players currently looking at this container. */
    this.viewers = 0;
    /** Optional per-slot filter: fn(index, stack) -> boolean. */
    this.slotFilter = null;
    if (be) this.attach(be);
  }

  /** Slots are the block entity's array once one is attached. */
  get slots() { return this._be ? this._be.slots : this._ownSlots; }
  set slots(v) {
    if (this._be) this._be.slots = v;
    else this._ownSlots = v;
  }

  /** The backing block entity, or null. */
  get be() { return this._be; }

  /**
   * Binds this container to a block entity, creating/resizing `be.slots` and
   * carrying over anything the container already held.
   */
  attach(be) {
    if (!be || typeof be !== 'object') return this;
    const previous = this._be ? null : this._ownSlots;
    if (!Array.isArray(be.slots)) be.slots = new Array(this.size).fill(null);
    while (be.slots.length < this.size) be.slots.push(null);
    if (be.slots.length > this.size) this.size = be.slots.length;
    for (let i = 0; i < be.slots.length; i++) be.slots[i] = sanitizeStack(be.slots[i]);
    this._be = be;
    if (previous) {
      for (let i = 0; i < previous.length && i < this.size; i++) {
        if (!isEmpty(previous[i]) && isEmpty(be.slots[i])) be.slots[i] = previous[i];
      }
    }
    if (be.x !== undefined) this.x = be.x | 0;
    if (be.y !== undefined) this.y = be.y | 0;
    if (be.z !== undefined) this.z = be.z | 0;
    if (!this.name && typeof be.customName === 'string') this.name = be.customName;
    this._ownSlots = null;
    return this;
  }

  /** Builds a container over an existing block entity. */
  static forBlockEntity(be, size = 27, name = '') {
    const n = be && Array.isArray(be.slots) ? Math.max(size | 0, be.slots.length) : size | 0;
    return new Container(n, name || (be && be.type) || '', be);
  }

  /**
   * Container for the block entity at a world position, creating the record's
   * slot array if the block entity exists but has never been opened.
   * Returns null when there is no block entity there.
   */
  static at(world, x, y, z, size = 27, name = '') {
    if (!world || typeof world.getBlockEntity !== 'function') return null;
    const be = world.getBlockEntity(x, y, z);
    if (!be) return null;
    const c = new Container(size, name || be.type || '', be, world, x, y, z);
    return c;
  }

  canAccept(i, s) {
    if (i < 0 || i >= this.size) return false;
    if (isEmpty(s)) return true;
    if (typeof this.slotFilter === 'function') {
      try { return !!this.slotFilter(i, s); } catch { return true; }
    }
    return true;
  }

  /** Also flags the block entity and its chunk so the world gets re-saved. */
  markChanged(index = -1) {
    const be = this._be;
    if (be) {
      be.dirty = true;
      const w = this.world;
      if (w && typeof w.chunkAt === 'function') {
        const c = w.chunkAt(this.x, this.z);
        if (c) c.modified = true;
      }
    }
    super.markChanged(index);
  }

  /** Opens the container: bumps the viewer count and plays the open sound. */
  open(player = null) {
    this.viewers++;
    if (this._be) this._be.viewers = this.viewers;
    if (this.viewers === 1) this._sound('chest_open', player);
    return this;
  }

  /** Closes the container. */
  close(player = null) {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this._be) this._be.viewers = this.viewers;
    if (this.viewers === 0) this._sound('chest_close', player);
    return this;
  }

  /** True while at least one player has it open. */
  isOpen() { return this.viewers > 0; }

  _sound(name, player) {
    const a = Game.audio;
    if (!a) return;
    const x = this.x + 0.5, y = this.y + 0.5, z = this.z + 0.5;
    try {
      if (a.playAt) a.playAt(name, x, y, z, 0.5, 0.9 + Math.random() * 0.2);
      else if (a.play) a.play(name, { volume: 0.5, pitch: 1, x, y, z });
    } catch { /* audio is optional */ }
    void player;
  }

  serialize() {
    const d = super.serialize();
    d.x = this.x; d.y = this.y; d.z = this.z;
    if (this._be && this._be.type) d.type = this._be.type;
    return d;
  }

  load(data) {
    super.load(data);
    if (data && !Array.isArray(data)) {
      if (typeof data.x === 'number') this.x = data.x | 0;
      if (typeof data.y === 'number') this.y = data.y | 0;
      if (typeof data.z === 'number') this.z = data.z | 0;
    }
    return this;
  }

  copy() {
    const out = new Container(this.size, this.name, null, this.world, this.x, this.y, this.z);
    for (let i = 0; i < this.size; i++) out.slots[i] = copyStack(this.slots[i]);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Cross-inventory operations
// ---------------------------------------------------------------------------

/**
 * Shift-click: moves everything it can from `from[fromIndex]` into `to`,
 * merging with matching stacks first and only then taking empty slots.
 *
 * `filter` gates what `to` will accept (see stackMatchesFilter). `range` is an
 * optional `[start, end)` restriction on the destination.
 *
 * Returns how many items moved.
 */
export function transferStack(from, fromIndex, to, filter = null, range = null) {
  if (!from || !to || typeof from.get !== 'function') return 0;
  const src = from.get(fromIndex);
  if (isEmpty(src)) return 0;
  if (filter !== null && filter !== undefined && !stackMatchesFilter(src, filter)) return 0;

  const size = to.size | 0;
  let lo = 0, hi = size;
  if (Array.isArray(range)) {
    lo = clamp(range[0] | 0, 0, size);
    hi = clamp(range[1] === undefined ? size : range[1] | 0, lo, size);
  }
  const accepts = typeof to.canAccept === 'function' ? (i, s) => to.canAccept(i, s) : () => true;
  const max = maxStackSize(src);
  const before = src.count | 0;

  // Pass 1: top up matching stacks.
  if (max > 1) {
    for (let i = lo; i < hi && src.count > 0; i++) {
      const dst = to.get(i);
      if (!dst || dst === src) continue;
      if (!sameItem(dst, src)) continue;
      if (!accepts(i, src)) continue;
      if (mergeInto(dst, src) > 0) {
        if (typeof to.markChanged === 'function') to.markChanged(i);
        else to.set(i, dst);
      }
    }
  }
  // Pass 2: fill empty slots.
  for (let i = lo; i < hi && src.count > 0; i++) {
    if (!isEmpty(to.get(i))) continue;
    if (!accepts(i, src)) continue;
    const put = Math.min(src.count | 0, max);
    to.set(i, withCount(src, put));
    src.count -= put;
  }

  const moved = before - (src.count | 0);
  if (moved > 0) {
    if ((src.count | 0) <= 0) from.set(fromIndex, null);
    else if (typeof from.markChanged === 'function') from.markChanged(fromIndex);
    else from.set(fromIndex, src);
  }
  return moved;
}

/**
 * Moves one item (or `count` items) between two inventories without needing a
 * source slot index - used by hoppers and droppers. Returns items moved.
 */
export function transferItem(from, to, count = 1, filter = null) {
  if (!from || !to) return 0;
  const want = Math.max(0, Math.floor(count));
  let moved = 0;
  for (let i = 0; i < from.size && moved < want; i++) {
    const s = from.get(i);
    if (isEmpty(s)) continue;
    if (filter !== null && filter !== undefined && !stackMatchesFilter(s, filter)) continue;
    const offer = withCount(s, Math.min(want - moved, s.count | 0));
    if (!offer) continue;
    const left = to.add(offer);
    const took = (offer.count | 0) - (left ? left.count | 0 : 0);
    if (took <= 0) continue;
    from.remove(i, took);
    moved += took;
  }
  return moved;
}

// Item ordering for sortInventory: creative-tab order first, registry order
// after. Built on first use so nothing runs at module-evaluation time.
let _orderIndex = null;
function itemOrder(name) {
  if (!_orderIndex) {
    _orderIndex = new Map();
    let i = 0;
    for (const tab of CREATIVE_TABS) {
      for (const n of tab.items) if (!_orderIndex.has(n)) _orderIndex.set(n, i++);
    }
    for (const n of ITEM_NAMES) if (!_orderIndex.has(n)) _orderIndex.set(n, i++);
  }
  const v = _orderIndex.get(name);
  return v === undefined ? 0x7fffffff : v;
}

/**
 * Merges duplicates, then sorts the inventory's sortable range into
 * creative-menu order (full stacks first within an item, damaged tools last).
 * Player inventories only sort their backpack rows, so the hotbar stays put.
 *
 * Returns true when anything moved.
 */
export function sortInventory(inv) {
  if (!inv || typeof inv.get !== 'function' || !Array.isArray(inv.slots)) return false;
  const [lo, hi] = typeof inv.sortRange === 'function' ? inv.sortRange() : [0, inv.size | 0];
  const items = [];
  for (let i = lo; i < hi; i++) {
    const s = inv.get(i);
    if (s) items.push(s);
  }
  if (items.length === 0) return false;

  // Merge partial stacks of identical items.
  const merged = [];
  for (const s of items) {
    let placed = false;
    const max = maxStackSize(s);
    if (max > 1) {
      for (const t of merged) {
        if (!sameItem(t, s)) continue;
        if (mergeInto(t, s) > 0 && (s.count | 0) <= 0) { placed = true; break; }
      }
    }
    if (!placed && (s.count | 0) > 0) merged.push(s);
  }

  merged.sort((a, b) => {
    const oa = itemOrder(a.item), ob = itemOrder(b.item);
    if (oa !== ob) return oa - ob;
    if (a.item !== b.item) return a.item < b.item ? -1 : 1;
    const da = a.damage | 0, db = b.damage | 0;
    if (da !== db) return da - db;
    const ca = a.count | 0, cb = b.count | 0;
    if (ca !== cb) return cb - ca;
    return 0;
  });

  // Write back, checking whether anything actually changed.
  let changed = false;
  for (let i = lo, k = 0; i < hi; i++, k++) {
    const want = k < merged.length ? merged[k] : null;
    if (inv.slots[i] !== want) changed = true;
    inv.slots[i] = want;
  }
  if (changed && typeof inv.markChanged === 'function') inv.markChanged(-1);
  return changed;
}

// Lazily loaded so importing inventory.js never drags in the entity graph.
let _itemEntity = null;
let _itemEntityPending = null;
function withItemEntities(fn) {
  if (_itemEntity) { try { fn(_itemEntity); } catch (e) { warnOnce('drop', 'drop failed', e); } return; }
  if (!_itemEntityPending) _itemEntityPending = import('../entity/itementity.js');
  _itemEntityPending.then(
    (m) => { _itemEntity = m; try { fn(m); } catch (e) { warnOnce('drop', 'drop failed', e); } },
    (e) => warnOnce('drop-mod', 'entity/itementity.js unavailable', e),
  );
}

/**
 * Empties an inventory into the world as loose item entities, the way a broken
 * chest or a dead player scatters its contents. Items carrying the Curse of
 * Vanishing are destroyed instead of dropped.
 *
 * The inventory is cleared synchronously; the entities appear as soon as
 * entity/itementity.js resolves. Returns how many stacks were dropped.
 */
export function dropAll(inv, world, x, y, z) {
  if (!inv) return 0;
  let taken;
  if (typeof inv.dropContents === 'function') {
    taken = inv.dropContents();
  } else {
    taken = [];
    const n = inv.size | 0;
    for (let i = 0; i < n; i++) {
      const s = inv.get(i);
      if (!s) continue;
      if (!vanishesOnDeath(s)) taken.push(s);
      inv.slots[i] = null;
    }
    if (typeof inv.markChanged === 'function') inv.markChanged(-1);
  }
  if (!taken.length || !world) return 0;

  const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
  withItemEntities((m) => {
    if (typeof m.dropItem !== 'function') return;
    for (const s of taken) {
      const a = Math.random() * Math.PI * 2;
      const speed = 0.05 + Math.random() * 0.15;
      m.dropItem(world, cx, cy, cz, s, Math.cos(a) * speed, 0.2 + Math.random() * 0.1, Math.sin(a) * speed);
    }
  });
  return taken.length;
}

/**
 * Convenience for "give this to the player, drop whatever will not fit".
 * Returns true when everything fit.
 */
export function giveOrDrop(player, s) {
  if (isEmpty(s) || !player) return false;
  const inv = player.inventory;
  let left = s;
  if (inv && typeof inv.add === 'function') left = inv.add(s);
  if (!left) return true;
  const world = player.world;
  if (!world) return false;
  withItemEntities((m) => {
    if (typeof m.dropItem === 'function') {
      m.dropItem(world, player.x, player.y + (player.eyeHeight || 1.5) - 0.3, player.z, left, 0, 0.1, 0);
    }
  });
  return false;
}

export default Inventory;
