// ============================================================================
// brewing.js - The potion tree.
//
// Everything a brewing stand can do lives here: the registry of every potion
// variant (`POTIONS`), the flat list of brewing recipes (`BREWING`), and the
// lookup helpers that items.js, screens.js, projectiles.js and loot.js use to
// turn a potion id into effects, a colour, a display name or an item name.
//
// Vocabulary, borrowed straight from vanilla:
//   * a *potion id* is the bare variant name - 'swiftness', 'long_swiftness',
//     'strong_swiftness'. It says nothing about how the potion is delivered.
//   * a *form* is how it is delivered - 'potion' (drinkable), 'splash_potion',
//     'lingering_potion' or 'tipped_arrow'.
//   * an *item name* combines the two: 'splash_potion_long_swiftness'. That is
//     exactly the naming items.js uses, so `potionItemName()` output can be fed
//     straight into `getItem()`.
//
// The three modifier ingredients behave the way they do in game: redstone
// extends a potion (and reverts a level II potion back to the extended level I
// one), glowstone dust amplifies it (dropping any extension), and a fermented
// spider eye corrupts it into its evil twin while keeping the modifier tier
// where a matching variant exists. Gunpowder and dragon's breath do not touch
// the potion at all - they only change the form.
//
// No DOM, no three.js, no Game access at module scope: tools/validate.mjs
// imports this file in plain Node.
// ============================================================================
import { TICKS_PER_SECOND } from '../core/constants.js';
import { prettyName } from '../core/util.js';
import {
  addEffect, effectDisplayName, formatEffectTime, getEffectDef,
} from './effects.js';

// ---------------------------------------------------------------------------
// Brewing stand constants
// ---------------------------------------------------------------------------

/** Ticks one brewing operation takes (20 seconds, as in vanilla). */
export const BREW_TICKS = 400;
/** Seconds per brew, for UI text. */
export const BREW_SECONDS = BREW_TICKS / TICKS_PER_SECOND;
/** Brews a single blaze powder pays for. */
export const BREW_FUEL_USES = 20;
/** The only fuel a brewing stand accepts. */
export const BREW_FUEL = 'blaze_powder';

/** Delivery forms, in the order the creative menu lists them. */
export const POTION_FORMS = ['potion', 'splash_potion', 'lingering_potion', 'tipped_arrow'];

/**
 * How long an effect lasts per form, relative to the drinkable potion.
 * Lingering clouds tick at a quarter, tipped arrows at an eighth.
 */
export const FORM_DURATION_SCALE = {
  potion: 1,
  splash_potion: 1,
  lingering_potion: 0.25,
  tipped_arrow: 0.125,
};

/** The fallback bottle colour (plain water). */
export const DEFAULT_POTION_COLOR = 0x385dc6;

// ---------------------------------------------------------------------------
// The potion registry
// ---------------------------------------------------------------------------

/** id -> potion definition. Keys match the ids items.js builds its items from. */
export const POTIONS = {};
/** Registration-ordered list of every potion id. */
export const POTION_NAMES = [];

// [ id, family, tier, label, colour, [[effect, ticks, amplifier], ...] ]
// tier: 0 = plain, 1 = extended (redstone), 2 = upgraded (glowstone).
// Durations are the vanilla ones and match src/item/items.js exactly.
const POTION_TABLE = [
  ['water', 'water', 0, 'Water Bottle', 0x385dc6, []],
  ['mundane', 'mundane', 0, 'Mundane', 0x385dc6, []],
  ['thick', 'thick', 0, 'Thick', 0x385dc6, []],
  ['awkward', 'awkward', 0, 'Awkward', 0x385dc6, []],
  ['uncraftable', 'uncraftable', 0, 'Uncraftable', 0xf800f8, []],

  ['night_vision', 'night_vision', 0, 'Night Vision', 0x1f1fa1, [['night_vision', 3600, 0]]],
  ['long_night_vision', 'night_vision', 1, 'Night Vision', 0x1f1fa1, [['night_vision', 9600, 0]]],

  ['invisibility', 'invisibility', 0, 'Invisibility', 0x7f8392, [['invisibility', 3600, 0]]],
  ['long_invisibility', 'invisibility', 1, 'Invisibility', 0x7f8392, [['invisibility', 9600, 0]]],

  ['leaping', 'leaping', 0, 'Leaping', 0x22ff4c, [['jump_boost', 3600, 0]]],
  ['long_leaping', 'leaping', 1, 'Leaping', 0x22ff4c, [['jump_boost', 9600, 0]]],
  ['strong_leaping', 'leaping', 2, 'Leaping', 0x22ff4c, [['jump_boost', 1800, 1]]],

  ['fire_resistance', 'fire_resistance', 0, 'Fire Resistance', 0xe49a3a, [['fire_resistance', 3600, 0]]],
  ['long_fire_resistance', 'fire_resistance', 1, 'Fire Resistance', 0xe49a3a, [['fire_resistance', 9600, 0]]],

  ['swiftness', 'swiftness', 0, 'Swiftness', 0x7cafc6, [['speed', 3600, 0]]],
  ['long_swiftness', 'swiftness', 1, 'Swiftness', 0x7cafc6, [['speed', 9600, 0]]],
  ['strong_swiftness', 'swiftness', 2, 'Swiftness', 0x7cafc6, [['speed', 1800, 1]]],

  ['slowness', 'slowness', 0, 'Slowness', 0x5a6c81, [['slowness', 1800, 0]]],
  ['long_slowness', 'slowness', 1, 'Slowness', 0x5a6c81, [['slowness', 4800, 0]]],
  ['strong_slowness', 'slowness', 2, 'Slowness', 0x5a6c81, [['slowness', 400, 3]]],

  ['turtle_master', 'turtle_master', 0, 'the Turtle Master', 0x9c9c9c,
    [['slowness', 400, 3], ['resistance', 400, 2]]],
  ['long_turtle_master', 'turtle_master', 1, 'the Turtle Master', 0x9c9c9c,
    [['slowness', 800, 3], ['resistance', 800, 2]]],
  ['strong_turtle_master', 'turtle_master', 2, 'the Turtle Master', 0x9c9c9c,
    [['slowness', 400, 5], ['resistance', 400, 3]]],

  ['water_breathing', 'water_breathing', 0, 'Water Breathing', 0x2e5299, [['water_breathing', 3600, 0]]],
  ['long_water_breathing', 'water_breathing', 1, 'Water Breathing', 0x2e5299, [['water_breathing', 9600, 0]]],

  ['healing', 'healing', 0, 'Healing', 0xf82423, [['instant_health', 1, 0]]],
  ['strong_healing', 'healing', 2, 'Healing', 0xf82423, [['instant_health', 1, 1]]],

  ['harming', 'harming', 0, 'Harming', 0x430a09, [['instant_damage', 1, 0]]],
  ['strong_harming', 'harming', 2, 'Harming', 0x430a09, [['instant_damage', 1, 1]]],

  ['poison', 'poison', 0, 'Poison', 0x4e9331, [['poison', 900, 0]]],
  ['long_poison', 'poison', 1, 'Poison', 0x4e9331, [['poison', 1800, 0]]],
  ['strong_poison', 'poison', 2, 'Poison', 0x4e9331, [['poison', 432, 1]]],

  ['regeneration', 'regeneration', 0, 'Regeneration', 0xcd5cab, [['regeneration', 900, 0]]],
  ['long_regeneration', 'regeneration', 1, 'Regeneration', 0xcd5cab, [['regeneration', 1800, 0]]],
  ['strong_regeneration', 'regeneration', 2, 'Regeneration', 0xcd5cab, [['regeneration', 450, 1]]],

  ['strength', 'strength', 0, 'Strength', 0x932423, [['strength', 3600, 0]]],
  ['long_strength', 'strength', 1, 'Strength', 0x932423, [['strength', 9600, 0]]],
  ['strong_strength', 'strength', 2, 'Strength', 0x932423, [['strength', 1800, 1]]],

  ['weakness', 'weakness', 0, 'Weakness', 0x484d48, [['weakness', 1800, 0]]],
  ['long_weakness', 'weakness', 1, 'Weakness', 0x484d48, [['weakness', 4800, 0]]],

  ['luck', 'luck', 0, 'Luck', 0x339900, [['luck', 6000, 0]]],

  ['slow_falling', 'slow_falling', 0, 'Slow Falling', 0xf7f8e0, [['slow_falling', 1800, 0]]],
  ['long_slow_falling', 'slow_falling', 1, 'Slow Falling', 0xf7f8e0, [['slow_falling', 4800, 0]]],
];

const isInstantEffect = (name) => {
  const d = getEffectDef(name);
  return !!d && !!d.instant;
};
const isHarmfulEffect = (name) => {
  const d = getEffectDef(name);
  return !!d && !!d.harmful;
};

/** "Potion of Swiftness" / "Awkward Potion" / "Water Bottle". */
function drinkableDisplay(id, label, hasEffects) {
  if (id === 'water') return 'Water Bottle';
  if (!hasEffects) return `${label} Potion`;
  return `Potion of ${label}`;
}

/**
 * Registers one potion variant. Returns the definition. Called only from this
 * module while the table above is walked.
 */
function definePotion(id, family, tier, label, color, rawEffects) {
  if (POTIONS[id]) return POTIONS[id];
  const effects = rawEffects.map(([effect, ticks, level]) => ({ effect, ticks, level }));
  const hasEffects = effects.length > 0;
  // The "primary" effect drives the duration/amplifier shown on the item; it is
  // the first non-instant one (turtle master reads as Slowness IV / 0:20).
  const primary = effects.find((e) => !isInstantEffect(e.effect)) || effects[0] || null;
  const def = {
    id,
    name: id,
    family,                                        // 'swiftness' for all three swiftness variants
    tier,                                          // 0 plain, 1 extended, 2 upgraded
    label,
    display: drinkableDisplay(id, label, hasEffects),
    color,
    effects,
    duration: primary ? primary.ticks : 0,
    amplifier: primary ? primary.level : 0,
    level: primary ? primary.level + 1 : 0,        // human-facing "Speed II" number
    instant: hasEffects && effects.every((e) => isInstantEffect(e.effect)),
    extended: tier === 1,
    upgraded: tier === 2,
    empty: !hasEffects,
    beneficial: hasEffects && !effects.some((e) => isHarmfulEffect(e.effect)),
    // item names items.js registers for this variant
    item: `potion_${id}`,
    splashItem: `splash_potion_${id}`,
    lingeringItem: `lingering_potion_${id}`,
    arrowItem: hasEffects ? `tipped_arrow_${id}` : 'tipped_arrow',
    // filled in once BREWING has been built
    redstone: null,        // what a redstone dust turns this into
    glowstone: null,       // what glowstone dust turns this into
    fermented: null,       // what a fermented spider eye turns this into
    ingredient: null,      // the ingredient that creates this potion
    from: [],              // [{ ingredient, base }] - every way to brew this
  };
  POTIONS[id] = def;
  POTION_NAMES.push(id);
  return def;
}

for (const [id, family, tier, label, color, effects] of POTION_TABLE) {
  definePotion(id, family, tier, label, color, effects);
}

/** Number of registered potion variants. */
export const POTION_COUNT = POTION_NAMES.length;

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------

/**
 * Every item that may sit in a brewing stand's ingredient slot.
 * `role`: 'base' | 'effect' | 'modifier' | 'form'.
 */
export const BREW_INGREDIENTS = {};

function defineIngredient(name, role, note) {
  BREW_INGREDIENTS[name] = { name, display: prettyName(name), role, note };
  return name;
}

defineIngredient('nether_wart', 'base', 'Turns a water bottle into an awkward potion');
defineIngredient('redstone', 'modifier', 'Extends the duration');
defineIngredient('glowstone_dust', 'modifier', 'Increases the strength');
defineIngredient('fermented_spider_eye', 'modifier', 'Corrupts the potion');
defineIngredient('gunpowder', 'form', 'Makes the potion throwable');
defineIngredient('dragon_breath', 'form', 'Turns a splash potion into a lingering one');

// awkward + X -> the base potion X makes.
const BASE_INGREDIENTS = {
  sugar: 'swiftness',
  rabbit_foot: 'leaping',
  blaze_powder: 'strength',
  glistering_melon_slice: 'healing',
  spider_eye: 'poison',
  ghast_tear: 'regeneration',
  magma_cream: 'fire_resistance',
  pufferfish: 'water_breathing',
  golden_carrot: 'night_vision',
  phantom_membrane: 'slow_falling',
  turtle_helmet: 'turtle_master',
};
for (const name of Object.keys(BASE_INGREDIENTS)) {
  defineIngredient(name, 'effect', `Awkward potion -> Potion of ${POTIONS[BASE_INGREDIENTS[name]].label}`);
}

/** Ingredient names in menu order: base, effect, modifier, form. */
export const BREW_INGREDIENT_NAMES = Object.keys(BREW_INGREDIENTS).sort((a, b) => {
  const order = { base: 0, effect: 1, modifier: 2, form: 3 };
  const d = order[BREW_INGREDIENTS[a].role] - order[BREW_INGREDIENTS[b].role];
  return d !== 0 ? d : a.localeCompare(b);
});

// ---------------------------------------------------------------------------
// The recipe list
// ---------------------------------------------------------------------------

/**
 * Every brewing recipe.
 *   kind 'potion': `from`/`to` are potion ids, the form is preserved.
 *   kind 'form':   `from`/`to` are form names, the potion id is preserved.
 */
export const BREWING = [];

/** ingredient -> Map(fromPotion -> toPotion). Built alongside BREWING. */
const TRANSFORMS = new Map();
/** ingredient -> { fromForm: toForm }. Only gunpowder and dragon's breath. */
const FORM_TRANSFORMS = Object.create(null);

function brew(ingredient, from, to) {
  if (!POTIONS[from] || !POTIONS[to]) return false;
  let m = TRANSFORMS.get(ingredient);
  if (!m) { m = new Map(); TRANSFORMS.set(ingredient, m); }
  if (m.has(from)) return false;              // first recipe registered wins
  m.set(from, to);
  BREWING.push({ kind: 'potion', ingredient, from, to });
  return true;
}

function brewForm(ingredient, from, to) {
  let m = FORM_TRANSFORMS[ingredient];
  if (!m) { m = FORM_TRANSFORMS[ingredient] = Object.create(null); }
  if (m[from]) return false;
  m[from] = to;
  BREWING.push({ kind: 'form', ingredient, from, to });
  return true;
}

const variant = (family, tier) => {
  const id = tier === 1 ? `long_${family}` : tier === 2 ? `strong_${family}` : family;
  return POTIONS[id] ? id : null;
};

// --- 1. the two starting potions -------------------------------------------
brew('nether_wart', 'water', 'awkward');
brew('glowstone_dust', 'water', 'thick');

// A water bottle plus anything else that has no water recipe of its own just
// yields a mundane potion. Redstone and every effect ingredient qualify.
brew('redstone', 'water', 'mundane');
for (const ing of Object.keys(BASE_INGREDIENTS)) brew(ing, 'water', 'mundane');

// --- 2. awkward -> the eleven base potions ---------------------------------
for (const [ing, result] of Object.entries(BASE_INGREDIENTS)) brew(ing, 'awkward', result);

// Weakness is the odd one out: it is brewed straight from a bottle, and any of
// the four effect-less potions can be corrupted into it.
for (const src of ['water', 'mundane', 'thick', 'awkward']) {
  brew('fermented_spider_eye', src, 'weakness');
}

// --- 3. redstone extends ---------------------------------------------------
// Extending a level II potion drops it back to the extended level I version,
// exactly like the real brewing stand.
for (const id of POTION_NAMES) {
  const def = POTIONS[id];
  if (def.tier === 1 || def.empty) continue;
  const long = variant(def.family, 1);
  if (long && long !== id) brew('redstone', id, long);
}

// --- 4. glowstone amplifies ------------------------------------------------
// Amplifying an extended potion drops the extension, again like vanilla.
for (const id of POTION_NAMES) {
  const def = POTIONS[id];
  if (def.tier === 2 || def.empty) continue;
  const strong = variant(def.family, 2);
  if (strong && strong !== id) brew('glowstone_dust', id, strong);
}

// --- 5. fermented spider eye corrupts --------------------------------------
// Each family maps to its evil twin; the modifier tier is kept when the twin
// has a matching variant, and falls back to the plain one when it does not
// (there is no "long harming", so long poison corrupts into plain harming).
const CORRUPTION = {
  swiftness: 'slowness',
  leaping: 'slowness',
  night_vision: 'invisibility',
  healing: 'harming',
  poison: 'harming',
};
for (const [src, dst] of Object.entries(CORRUPTION)) {
  for (let tier = 0; tier <= 2; tier++) {
    const from = variant(src, tier);
    if (!from) continue;
    const to = variant(dst, tier) || variant(dst, 0);
    if (to) brew('fermented_spider_eye', from, to);
  }
}

// --- 6. gunpowder and dragon's breath change the form ----------------------
brewForm('gunpowder', 'potion', 'splash_potion');
brewForm('dragon_breath', 'splash_potion', 'lingering_potion');

// --- 7. back-references used by tooltips and the recipe book ---------------
const MODIFIER_FIELD = {
  redstone: 'redstone',
  glowstone_dust: 'glowstone',
  fermented_spider_eye: 'fermented',
};
for (const r of BREWING) {
  if (r.kind !== 'potion') continue;
  const from = POTIONS[r.from];
  const to = POTIONS[r.to];
  const field = MODIFIER_FIELD[r.ingredient];
  if (field && from[field] === null) from[field] = r.to;
  if (!to.ingredient && !field) to.ingredient = r.ingredient;
  to.from.push({ ingredient: r.ingredient, base: r.from });
}

/** Number of registered brewing recipes. */
export const BREWING_COUNT = BREWING.length;

// ---------------------------------------------------------------------------
// Name plumbing
// ---------------------------------------------------------------------------

// Longest prefix first so 'splash_potion_x' never matches the 'potion' branch.
const FORM_PREFIXES = [
  ['lingering_potion', 'lingering_potion'],
  ['splash_potion', 'splash_potion'],
  ['tipped_arrow', 'tipped_arrow'],
  ['potion', 'potion'],
];

/** Pulls the plain item/ingredient name out of a string or an ItemStack. */
function nameOf(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') {
    if (typeof x.item === 'string') return x.item;
    if (typeof x.name === 'string') return x.name;
    if (typeof x.id === 'string') return x.id;
  }
  return null;
}

/**
 * Splits a potion item name into `{ form, potion }`, or null when the name is
 * not a potion item. The bare items ('potion', 'splash_potion', ...) count as
 * water, matching items.js.
 */
export function parsePotionItem(itemName) {
  const n = nameOf(itemName);
  if (!n) return null;
  for (const [prefix, form] of FORM_PREFIXES) {
    if (n === prefix) return { form, potion: 'water' };
    if (n.length > prefix.length + 1 && n.startsWith(prefix) && n[prefix.length] === '_') {
      const id = n.slice(prefix.length + 1);
      if (POTIONS[id]) return { form, potion: id };
    }
  }
  return null;
}

/** True when `itemName` is a potion, splash/lingering potion or tipped arrow. */
export function isPotionItem(itemName) {
  return parsePotionItem(itemName) !== null;
}

/**
 * Canonical potion id for anything that identifies a potion: an id
 * ('swiftness'), an item name ('splash_potion_swiftness'), or a stack whose
 * `potion` field carries the id. Returns null when nothing matches.
 */
export function resolvePotionId(x) {
  if (x == null) return null;
  if (typeof x === 'object' && typeof x.potion === 'string' && POTIONS[x.potion]) return x.potion;
  const n = nameOf(x);
  if (!n) return null;
  if (POTIONS[n]) return n;
  const parsed = parsePotionItem(n);
  return parsed ? parsed.potion : null;
}

/** Potion definition for an id/item name/stack, or null. */
export function getPotion(x) {
  const id = resolvePotionId(x);
  return id ? POTIONS[id] : null;
}

/** True when `id` is a registered potion variant. */
export function potionExists(id) {
  return typeof id === 'string' && !!POTIONS[id];
}

/**
 * Item name for a potion in a given form: `potionItemName('swiftness',
 * 'splash_potion')` -> 'splash_potion_swiftness'. Effect-less potions have no
 * tipped arrow, so those fall back to the plain 'tipped_arrow' item.
 */
export function potionItemName(potionName, form = 'potion') {
  const def = getPotion(potionName);
  if (!def) return form === 'tipped_arrow' ? 'tipped_arrow' : form;
  switch (form) {
    case 'splash_potion': return def.splashItem;
    case 'lingering_potion': return def.lingeringItem;
    case 'tipped_arrow': return def.arrowItem;
    default: return def.item;
  }
}

/**
 * The tipped arrow made from a potion. Potions with no effects (water,
 * mundane, thick, awkward, uncraftable) have no dedicated arrow, so this
 * returns the plain 'tipped_arrow' item for them - it is always a real,
 * registered item name.
 */
export function tippedArrowFor(potionName) {
  const def = getPotion(potionName);
  return def ? def.arrowItem : 'tipped_arrow';
}

/** The splash version of a potion item or id, as an item name. */
export function splashOf(potionName) {
  return potionItemName(potionName, 'splash_potion');
}

/** The lingering version of a potion item or id, as an item name. */
export function lingeringOf(potionName) {
  return potionItemName(potionName, 'lingering_potion');
}

// ---------------------------------------------------------------------------
// Potion queries
// ---------------------------------------------------------------------------

/**
 * The effects a potion grants when drunk, as fresh
 * `[{ effect, ticks, level }]` records. `level` is the amplifier (0 = "I").
 * Unknown names give an empty array rather than throwing.
 */
export function potionEffects(potionName) {
  const def = getPotion(potionName);
  if (!def) return [];
  const out = new Array(def.effects.length);
  for (let i = 0; i < def.effects.length; i++) {
    const e = def.effects[i];
    out[i] = { effect: e.effect, ticks: e.ticks, level: e.level };
  }
  return out;
}

/**
 * Effects scaled for a delivery form: lingering clouds apply a quarter of the
 * duration, tipped arrows an eighth. Instant effects are never scaled.
 */
export function potionEffectsFor(potionName, form = 'potion') {
  const scale = FORM_DURATION_SCALE[form] !== undefined ? FORM_DURATION_SCALE[form] : 1;
  const list = potionEffects(potionName);
  if (scale === 1) return list;
  for (const e of list) {
    if (isInstantEffect(e.effect)) continue;
    e.ticks = Math.max(1, Math.floor(e.ticks * scale));
  }
  return list;
}

/** Bottle/particle colour for a potion, as 0xRRGGBB. */
export function potionColor(potionName) {
  const def = getPotion(potionName);
  return def ? def.color : DEFAULT_POTION_COLOR;
}

/**
 * "Potion of Swiftness", "Splash Potion of Swiftness", "Awkward Potion",
 * "Water Bottle", "Arrow of Poison". The optional `form` argument defaults to
 * the drinkable bottle and matches the names items.js registers.
 */
export function potionDisplayName(potionName, form = 'potion') {
  const def = getPotion(potionName);
  if (!def) {
    const n = nameOf(potionName);
    return n ? prettyName(n) : 'Potion';
  }
  const water = def.id === 'water';
  switch (form) {
    case 'splash_potion':
      if (water) return 'Splash Water Bottle';
      return def.empty ? `Splash ${def.label} Potion` : `Splash Potion of ${def.label}`;
    case 'lingering_potion':
      if (water) return 'Lingering Water Bottle';
      return def.empty ? `Lingering ${def.label} Potion` : `Lingering Potion of ${def.label}`;
    case 'tipped_arrow':
      if (water) return 'Arrow of Splashing';
      return def.empty ? 'Arrow' : `Arrow of ${def.label}`;
    default:
      return def.display;
  }
}

/** True when the potion only carries instant effects (healing / harming). */
export function isInstantPotion(potionName) {
  const def = getPotion(potionName);
  return !!def && def.instant;
}

/** True when nothing bad happens to whoever drinks it. */
export function isBeneficialPotion(potionName) {
  const def = getPotion(potionName);
  return !!def && def.beneficial;
}

/**
 * Tooltip lines for a potion, in the `{ text, color }` shape the inventory
 * screens use. Green for buffs, red for debuffs, grey for an empty bottle.
 */
export function potionTooltipLines(potionName, form = 'potion') {
  const def = getPotion(potionName);
  if (!def || def.empty) return [{ text: 'No Effects', color: '#7f7f7f' }];
  const lines = [];
  for (const e of potionEffectsFor(def.id, form)) {
    const label = effectDisplayName(e.effect, e.level);
    const instant = isInstantEffect(e.effect);
    lines.push({
      text: instant ? label : `${label} (${formatEffectTime(e.ticks)})`,
      color: isHarmfulEffect(e.effect) ? '#fc5454' : '#54fc54',
    });
  }
  return lines;
}

/**
 * Applies a potion's effects to an entity. `durationScale` is the extra
 * multiplier a splash potion applies for distance (1 at point blank).
 * Returns how many effects actually landed.
 */
export function applyPotion(entity, potionName, form = 'potion', durationScale = 1) {
  if (!entity) return 0;
  let applied = 0;
  for (const e of potionEffectsFor(potionName, form)) {
    const instant = isInstantEffect(e.effect);
    const ticks = instant ? 1 : Math.max(1, Math.floor(e.ticks * durationScale));
    if (addEffect(entity, e.effect, ticks, e.level)) applied++;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Brewing
// ---------------------------------------------------------------------------

/** True when the item may be dropped into a brewing stand's ingredient slot. */
export function isValidBrewIngredient(itemName) {
  const n = nameOf(itemName);
  return !!n && !!BREW_INGREDIENTS[n];
}

/** Descriptor for an ingredient (`{ name, display, role, note }`) or null. */
export function brewIngredientInfo(itemName) {
  const n = nameOf(itemName);
  return (n && BREW_INGREDIENTS[n]) || null;
}

/** True when the item is blaze powder, the brewing stand's only fuel. */
export function isBrewFuel(itemName) {
  return nameOf(itemName) === BREW_FUEL;
}

/** Splits a base into `{ potion, form, wasItem }`, or null. */
function resolveBase(base) {
  if (base == null) return null;
  if (typeof base === 'object') {
    const n = nameOf(base);
    const parsed = n ? parsePotionItem(n) : null;
    if (parsed) {
      // A stack may carry an explicit potion id (creative / command-given).
      const id = typeof base.potion === 'string' && POTIONS[base.potion] ? base.potion : parsed.potion;
      return { potion: id, form: parsed.form, wasItem: true };
    }
    if (typeof base.potion === 'string' && POTIONS[base.potion]) {
      return { potion: base.potion, form: 'potion', wasItem: false };
    }
    return null;
  }
  if (typeof base !== 'string') return null;
  if (POTIONS[base]) return { potion: base, form: 'potion', wasItem: false };
  const parsed = parsePotionItem(base);
  return parsed ? { potion: parsed.potion, form: parsed.form, wasItem: true } : null;
}

/**
 * Core brewing step: given an ingredient and a `{ potion, form }` pair, returns
 * the new `{ potion, form }` or null when the combination does nothing.
 */
export function brewOutcome(ingredient, potion, form = 'potion') {
  const ing = nameOf(ingredient);
  if (!ing || !POTIONS[potion]) return null;
  if (form === 'tipped_arrow') return null;        // arrows are crafted, not brewed

  const forms = FORM_TRANSFORMS[ing];
  if (forms) {
    const next = forms[form];
    return next ? { potion, form: next } : null;
  }
  const m = TRANSFORMS.get(ing);
  if (!m) return null;
  const to = m.get(potion);
  return to ? { potion: to, form } : null;
}

/**
 * What a brewing stand produces from one ingredient and one bottle.
 *
 * `basePotion` may be a potion id ('awkward'), a potion item name
 * ('potion_awkward', 'splash_potion_awkward') or an ItemStack. The answer comes
 * back in the same shape: a bare id in, a bare id out - except when the
 * ingredient changes the *form*, which a bare id cannot express, in which case
 * the full item name is returned. Returns null when nothing would happen.
 */
export function brewResult(ingredient, basePotion) {
  const ing = nameOf(ingredient);
  if (!ing) return null;
  const base = resolveBase(basePotion);
  if (!base) return null;
  const out = brewOutcome(ing, base.potion, base.form);
  if (!out) return null;
  if (base.wasItem || out.form !== base.form) return potionItemName(out.potion, out.form);
  return out.potion;
}

/** True when `brewResult` would produce something. */
export function canBrew(ingredient, basePotion) {
  return brewResult(ingredient, basePotion) !== null;
}

/** Every recipe whose output is this potion: `[{ ingredient, base }]`. */
export function brewingRecipesFor(potionName) {
  const def = getPotion(potionName);
  return def ? def.from.map((r) => ({ ingredient: r.ingredient, base: r.base })) : [];
}

/** Every recipe that uses this ingredient: `[{ ingredient, from, to, kind }]`. */
export function brewingRecipesWith(itemName) {
  const n = nameOf(itemName);
  if (!n) return [];
  return BREWING.filter((r) => r.ingredient === n);
}

/**
 * The chain of ingredients that brews `potionName` starting from a water
 * bottle, e.g. ['nether_wart', 'sugar', 'glowstone_dust'] for Swiftness II.
 * Returns null for potions no recipe can reach (luck, uncraftable).
 */
export function brewingPath(potionName) {
  const target = resolvePotionId(potionName);
  if (!target) return null;
  if (target === 'water') return [];
  // Breadth-first from the water bottle; the tree is tiny so this is cheap.
  const seen = new Set(['water']);
  const queue = [{ potion: 'water', path: [] }];
  while (queue.length) {
    const cur = queue.shift();
    const def = POTIONS[cur.potion];
    if (!def) continue;
    for (const r of BREWING) {
      if (r.kind !== 'potion' || r.from !== cur.potion) continue;
      if (seen.has(r.to)) continue;
      const path = cur.path.concat(r.ingredient);
      if (r.to === target) return path;
      seen.add(r.to);
      queue.push({ potion: r.to, path });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Brewing stand block entity
//
// Slot layout matches the vanilla container: 0..2 bottles, 3 ingredient,
// 4 blaze powder. Everything here is defensive so a half-loaded save or a
// freshly placed stand never throws inside the tick loop.
// ---------------------------------------------------------------------------

export const BREW_BOTTLE_COUNT = 3;
export const BREW_SLOT_INGREDIENT = 3;
export const BREW_SLOT_FUEL = 4;
export const BREW_SLOT_COUNT = 5;

/** A fresh brewing stand block entity. */
export function createBrewingStand() {
  return {
    type: 'brewing_stand',
    slots: [null, null, null, null, null],
    brewTime: 0,
    fuel: 0,
    brewed: 0,
  };
}

function bottleCount(slots) {
  let n = 0;
  for (let i = 0; i < BREW_BOTTLE_COUNT; i++) if (slots[i]) n++;
  return n;
}

/**
 * What each of the three bottle slots would turn into with the ingredient
 * currently loaded. Entries are item names, or null for "no reaction".
 */
export function brewingStandOutputs(be) {
  const out = [null, null, null];
  if (!be || !be.slots) return out;
  const slots = be.slots;
  const ing = nameOf(slots[BREW_SLOT_INGREDIENT]);
  if (!ing || !BREW_INGREDIENTS[ing]) return out;
  const ingStack = slots[BREW_SLOT_INGREDIENT];
  if (ingStack && typeof ingStack === 'object' && (ingStack.count | 0) <= 0) return out;
  for (let i = 0; i < BREW_BOTTLE_COUNT; i++) {
    const bottle = slots[i];
    if (!bottle) continue;
    if (typeof bottle === 'object' && (bottle.count | 0) <= 0) continue;
    const parsed = parsePotionItem(bottle);
    if (!parsed) continue;
    const result = brewResult(ing, bottle);
    if (result && result !== nameOf(bottle)) out[i] = result;
  }
  return out;
}

/**
 * Advances a brewing stand by one tick. Returns true when the caller should
 * refresh the UI or the block model (progress moved, fuel burned, potions
 * finished). Pure state machine - it never touches the world directly.
 */
export function tickBrewingStand(be) {
  if (!be) return false;
  const slots = be.slots || (be.slots = [null, null, null, null, null]);
  if (typeof be.brewTime !== 'number') be.brewTime = 0;
  if (typeof be.fuel !== 'number') be.fuel = 0;

  const outputs = brewingStandOutputs(be);
  const active = outputs[0] !== null || outputs[1] !== null || outputs[2] !== null;

  if (!active) {
    if (be.brewTime !== 0) { be.brewTime = 0; return true; }
    return false;
  }

  // Burn a blaze powder when the stand is out of charges.
  let changed = false;
  if (be.fuel <= 0) {
    const fuel = slots[BREW_SLOT_FUEL];
    if (fuel && isBrewFuel(fuel) && (fuel.count | 0) > 0) {
      fuel.count -= 1;
      if (fuel.count <= 0) slots[BREW_SLOT_FUEL] = null;
      be.fuel = BREW_FUEL_USES;
      changed = true;
    } else {
      if (be.brewTime !== 0) { be.brewTime = 0; changed = true; }
      return changed;
    }
  }

  if (be.brewTime <= 0) { be.brewTime = BREW_TICKS; changed = true; }
  be.brewTime--;

  if (be.brewTime <= 0) {
    for (let i = 0; i < BREW_BOTTLE_COUNT; i++) {
      if (!outputs[i]) continue;
      const prev = slots[i];
      slots[i] = {
        item: outputs[i],
        count: prev && typeof prev === 'object' ? Math.max(1, prev.count | 0) : 1,
        damage: 0,
      };
    }
    const ing = slots[BREW_SLOT_INGREDIENT];
    if (ing && typeof ing === 'object') {
      ing.count -= 1;
      if (ing.count <= 0) slots[BREW_SLOT_INGREDIENT] = null;
    } else if (ing) {
      slots[BREW_SLOT_INGREDIENT] = null;
    }
    be.fuel = Math.max(0, be.fuel - 1);
    be.brewTime = 0;
    be.brewed = (be.brewed | 0) + 1;
    return true;
  }
  return true;
}

/** 0..1 progress of the current brew, for the bubble/arrow widget. */
export function brewProgress(be) {
  if (!be || !be.brewTime) return 0;
  return 1 - be.brewTime / BREW_TICKS;
}

/** How many bottles are loaded, for the stand's block model. */
export function brewingStandBottles(be) {
  return be && be.slots ? bottleCount(be.slots) : 0;
}

export default POTIONS;
