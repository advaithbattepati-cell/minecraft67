// ============================================================================
// trading.js - Villager professions, their five tiers of trades, the wandering
// trader, gossip-based price discounts and the trade transaction itself.
//
// Structure mirrors vanilla `VillagerTrades`:
//   * a profession owns five *pools* of trade "listings" (novice .. master);
//   * a villager rolls TRADES_PER_TIER listings out of the pool for every tier
//     it has unlocked, and each listing bakes its randomness (enchantments,
//     dye colours, book prices) into a concrete offer at roll time;
//   * an offer is spent by `useTrade`, which handles stock, demand, villager
//     xp and levelling up.
//
// Nothing here touches the DOM, three.js or `Game.*` at module scope, so the
// file imports cleanly in Node for tools/validate.mjs. The few places that do
// reach into the running game (item entities for the xp orbs) go through a
// lazy `import()` inside the handler.
// ============================================================================
import { clamp, prettyName } from '../core/util.js';
import { RNG } from '../core/rng.js';
import { Game } from '../core/game.js';
import { getItem } from './items.js';
import { ENCHANTMENTS, applyEnchant, enchantWithLevels, randomBookEnchant } from './enchanting.js';
import { effectLevel } from './effects.js';
import { POTION_NAMES, getPotion, tippedArrowFor as tippedArrowItem } from './brewing.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tier names, index 0 = level 1. */
export const TRADE_LEVELS = Object.freeze(['novice', 'apprentice', 'journeyman', 'expert', 'master']);
/** Highest villager level. */
export const MAX_VILLAGER_LEVEL = 5;
/** How many listings a villager draws out of each tier's pool. */
export const TRADES_PER_TIER = 2;
/**
 * Villager xp needed to *leave* the level used as the index (1-based):
 * LEVEL_XP[1] = 10 xp to become an apprentice, [4] = 250 to become a master.
 */
export const LEVEL_XP = Object.freeze([0, 10, 70, 150, 250]);
/** Ticks between two automatic restocks (vanilla restocks twice a day). */
export const RESTOCK_INTERVAL = 12000;
/** Player xp awarded per completed trade: 3 + rand(4). */
export const TRADE_XP_MIN = 3;
export const TRADE_XP_SPREAD = 4;

/** The 16 dye colours, in vanilla registry order. */
export const DYE_COLORS = Object.freeze(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime',
  'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']);
/** Matching dye RGB values, used when a leatherworker tints armour. */
const DYE_HEX = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52,
  0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21];

const BOAT_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'];

/**
 * Gossip entries, exactly as vanilla weights them. `weight` multiplies the
 * stored value into a reputation score, `max` caps one entry and `decay` is
 * subtracted once per in-game day.
 */
export const GOSSIP_TYPES = Object.freeze({
  major_negative: { weight: -5, max: 100, decay: 10 },
  minor_negative: { weight: -1, max: 200, decay: 20 },
  minor_positive: { weight: 1, max: 200, decay: 1 },
  major_positive: { weight: 5, max: 100, decay: 0 },
  trading: { weight: 1, max: 25, decay: 2 },
});

/** Explorer-map flavour: display name, map marker and tint. */
export const EXPLORER_MAPS = Object.freeze({
  monument: { display: 'Ocean Explorer Map', marker: 'monument', color: 0x3f76e4, structure: 'ocean_monument' },
  mansion: { display: 'Woodland Explorer Map', marker: 'mansion', color: 0x6b4423, structure: 'woodland_mansion' },
  buried_treasure: { display: 'Buried Treasure Map', marker: 'red_x', color: 0xc0a060, structure: 'buried_treasure' },
  trial_chambers: { display: 'Trial Explorer Map', marker: 'trial_chambers', color: 0x9a7bbf, structure: 'trial_chambers' },
});

// ---------------------------------------------------------------------------
// Small local helpers (deliberately duplicated so this module stands alone)
// ---------------------------------------------------------------------------

/** Makes a bare item stack. Matches `inventory.stack()`'s shape. */
function mkStack(item, count = 1, extra = null) {
  const s = { item, count, damage: 0 };
  if (extra) Object.assign(s, extra);
  return s;
}

/** Deep-enough copy of a stack: enchantment maps and map data are cloned. */
export function copyTradeStack(s) {
  if (!s) return null;
  const out = { ...s };
  if (s.enchants) { out.enchants = { ...s.enchants }; out.enchantments = out.enchants; }
  if (s.map) out.map = { ...s.map };
  if (s.stewEffect) out.stewEffect = { ...s.stewEffect };
  if (s.effects) out.effects = s.effects.map((e) => ({ ...e }));
  return out;
}

/** Maximum stack size for an item name (64 when unknown). */
function maxStackOf(name) {
  const d = getItem(name);
  return d && d.stack ? d.stack : 64;
}

/** Accepts an RNG, a bare `() => [0,1)` function, or nothing at all. */
function wrapRng(rng) {
  if (rng && typeof rng.next === 'function' && typeof rng.int === 'function') return rng;
  if (typeof rng === 'function') {
    return {
      next: rng,
      int: (n) => Math.floor(rng() * n),
      range: (a, b) => a + Math.floor(rng() * (b - a + 1)),
      chance: (p) => rng() < p,
      pick: (a) => (a.length ? a[Math.floor(rng() * a.length)] : undefined),
    };
  }
  return new RNG((Math.random() * 0xffffffff) >>> 0);
}

function playAt(x, y, z, name, vol = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || !name) return;
  try {
    if (a.playAt) a.playAt(name, x, y, z, vol, pitch);
    else if (a.play) a.play(name, { volume: vol, pitch, x, y, z });
  } catch { /* audio is optional */ }
}

function particles(type, x, y, z, opts) {
  try { Game.particles?.spawn?.(type, x, y, z, opts); } catch { /* particles are optional */ }
}

let _warned = null;
/** Runs `fn` once a lazily-imported module resolves. Failures are reported once. */
function withMod(loader, fn) {
  let p;
  try { p = loader(); } catch (e) { p = Promise.reject(e); }
  p.then(
    (m) => { try { fn(m); } catch (e) { console.warn('[trading] handler failed', e); } },
    (e) => {
      const k = String(e && e.message);
      if (!_warned) _warned = new Set();
      if (!_warned.has(k)) { _warned.add(k); console.warn('[trading] module unavailable', e); }
    },
  );
}

// ---------------------------------------------------------------------------
// The offer object
// ---------------------------------------------------------------------------

/**
 * Builds one concrete offer.
 * `buy` is the primary cost (often emeralds, but a "villager buys wheat" trade
 * puts the wheat here - discounts always apply to this stack, like vanilla).
 */
function offer(buy, buyB, sell, maxUses, xp, priceMultiplier = 0.05) {
  return {
    buy,
    buyB: buyB || null,
    sell,
    maxUses,
    uses: 0,
    xp,
    priceMultiplier,
    demand: 0,
    specialPrice: 0,
    price: buy.count,          // last computed price, refreshed by tradePrice()
    disabled: false,
    rewardXp: true,
    tier: 1,
    listing: null,
  };
}

// ---------------------------------------------------------------------------
// Listing factories. A listing is a template; `roll(rng)` bakes one offer.
// ---------------------------------------------------------------------------

/**
 * "Villager buys N of an item for one emerald."
 * Bulk purchases wobble a little between villagers (+/- 10% of the count,
 * capped at 3) so two farmers never feel identical; small counts stay exact.
 */
function buyFor(item, count, maxUses = 16, xp = 2, opts = {}) {
  const spread = opts.spread !== undefined ? opts.spread : Math.min(3, Math.floor(count / 10));
  const pm = opts.priceMultiplier !== undefined ? opts.priceMultiplier : 0.05;
  return {
    kind: 'buy', id: 'buy:' + item, item, count, spread, maxUses, xp, priceMultiplier: pm,
    roll(r) {
      const n = spread > 0 ? count + r.range(-spread, spread) : count;
      // Clamp to the registry's stack size so a cost never overflows its slot.
      return offer(mkStack(item, clamp(n, 1, maxStackOf(item))), null,
        mkStack('emerald', opts.emeralds || 1), maxUses, xp, pm);
    },
  };
}

/** "Villager sells N of an item for P emeralds." */
function sellFor(item, price, count = 1, maxUses = 12, xp = 1, opts = {}) {
  const pm = opts.priceMultiplier !== undefined ? opts.priceMultiplier : 0.05;
  return {
    kind: 'sell', id: 'sell:' + item, item, price, count, maxUses, xp, priceMultiplier: pm,
    roll(r) {
      const s = mkStack(item, clamp(count, 1, maxStackOf(item)));
      if (opts.decorate) opts.decorate(s, r);
      return offer(mkStack('emerald', price), null, s, maxUses, xp, pm);
    },
  };
}

/** "P emeralds + N raw items -> M processed items" (cooked fish, gravel -> flint). */
function convertFor(inItem, inCount, outItem, outCount, price, maxUses = 16, xp = 1) {
  return {
    kind: 'convert', id: 'convert:' + inItem + '>' + outItem,
    item: outItem, inItem, inCount, count: outCount, price, maxUses, xp, priceMultiplier: 0.05,
    roll() {
      return offer(mkStack('emerald', price), mkStack(inItem, inCount), mkStack(outItem, outCount),
        maxUses, xp, 0.05);
    },
  };
}

/**
 * "Villager sells one enchanted tool/weapon/armour piece."
 * Vanilla rolls a 5..19 enchanting power, applies it, then charges
 * `base + power` emeralds (capped at a stack).
 */
function enchantedFor(item, basePrice, maxUses = 12, xp = 1) {
  return {
    kind: 'enchanted', id: 'enchanted:' + item, item, price: basePrice, count: 1,
    maxUses, xp, priceMultiplier: 0.2,
    roll(r) {
      const power = 5 + r.int(15);
      const s = mkStack(item, 1);
      enchantWithLevels(s, power, r, false);
      const price = Math.min(64, basePrice + power);
      return offer(mkStack('emerald', price), null, s, maxUses, xp, 0.2);
    },
  };
}

/**
 * The librarian's enchanted book: a random tradeable enchantment at a random
 * level, priced `2 + rand(5 + 10*level) + 3*level` emeralds plus one book,
 * doubled for treasure enchantments and capped at 64.
 */
function bookFor(xp, maxUses = 12) {
  return {
    kind: 'book', id: 'book:' + xp, item: 'enchanted_book', count: 1, maxUses, xp, priceMultiplier: 0.2,
    roll(r) {
      const pick = randomBookEnchant(r, true) || { name: 'unbreaking', level: 1 };
      const def = ENCHANTMENTS[pick.name];
      const lvl = clamp(pick.level | 0 || 1, 1, def ? def.maxLevel : 5);
      let price = 2 + r.int(5 + lvl * 10) + 3 * lvl;
      if (def && def.treasure) price *= 2;
      if (price > 64) price = 64;
      const s = mkStack('enchanted_book', 1, { rarity: 'uncommon' });
      applyEnchant(s, pick.name, lvl);
      return offer(mkStack('emerald', price), mkStack('book', 1), s, maxUses, xp, 0.2);
    },
  };
}

/** The cartographer's explorer maps: emeralds + a compass for a marked map. */
function explorerMapFor(kind, price, maxUses = 12, xp = 5) {
  const info = EXPLORER_MAPS[kind] || EXPLORER_MAPS.monument;
  return {
    kind: 'map', id: 'map:' + kind, item: 'filled_map', mapKind: kind, price, count: 1,
    maxUses, xp, priceMultiplier: 0.2,
    roll(r) {
      const s = mkStack('filled_map', 1, {
        display: info.display,
        rarity: 'uncommon',
        map: {
          kind, marker: info.marker, structure: info.structure, color: info.color,
          scale: 2, x: null, z: null, dimension: 'overworld',
          // Explorer maps are issued blank and get their target filled in the
          // first time the world locates the structure for this player.
          resolved: false, salt: r.int(0x7fffffff),
        },
      });
      return offer(mkStack('emerald', price), mkStack('compass', 1), s, maxUses, xp, 0.2);
    },
  };
}

/** The farmer's suspicious stew, one emerald for a stew with a hidden effect. */
function stewFor(effect, ticks, xp) {
  return {
    kind: 'stew', id: 'stew:' + effect, item: 'suspicious_stew', effect, ticks,
    price: 1, count: 1, maxUses: 12, xp, priceMultiplier: 0.05,
    roll() {
      const s = mkStack('suspicious_stew', 1, {
        stewEffect: { effect, ticks, level: 0 },
        effects: [{ effect, ticks, level: 0 }],
      });
      return offer(mkStack('emerald', 1), null, s, 12, xp, 0.05);
    },
  };
}

/** Mixes dye colours the way a cauldron does: average, then rescale to the brightest. */
function mixDyes(indices) {
  let r = 0, g = 0, b = 0, maxSum = 0;
  for (const i of indices) {
    const hex = DYE_HEX[i];
    const cr = (hex >> 16) & 255, cg = (hex >> 8) & 255, cb = hex & 255;
    maxSum += Math.max(cr, Math.max(cg, cb));
    r += cr; g += cg; b += cb;
  }
  const n = indices.length || 1;
  let ar = r / n, ag = g / n, ab = b / n;
  const avgMax = maxSum / n;
  const gain = Math.max(ar, Math.max(ag, ab)) || 1;
  const k = avgMax / gain;
  ar = Math.min(255, Math.round(ar * k));
  ag = Math.min(255, Math.round(ag * k));
  ab = Math.min(255, Math.round(ab * k));
  return (ar << 16) | (ag << 8) | ab;
}

/** The leatherworker's tinted leather: one to three random dyes mixed in. */
function dyedFor(item, price, maxUses = 12, xp = 1) {
  return {
    kind: 'dyed', id: 'dyed:' + item, item, price, count: 1, maxUses, xp, priceMultiplier: 0.05,
    roll(r) {
      const picks = [r.int(16)];
      if (r.next() > 0.7) picks.push(r.int(16));
      if (r.next() > 0.8) picks.push(r.int(16));
      const s = mkStack(item, 1, {
        color: mixDyes(picks),
        dyes: picks.map((i) => DYE_COLORS[i]),
      });
      return offer(mkStack('emerald', price), null, s, maxUses, xp, 0.05);
    },
  };
}

let _tippedPool = null;
/** Potions that make a meaningful tipped arrow (skips water/mundane/awkward). */
function tippedPotions() {
  if (_tippedPool) return _tippedPool;
  _tippedPool = POTION_NAMES.filter((n) => {
    const p = getPotion(n);
    return p && Array.isArray(p.effects) && p.effects.length > 0;
  });
  if (!_tippedPool.length) _tippedPool = ['poison'];
  return _tippedPool;
}

/** The master fletcher's tipped arrows: emeralds + plain arrows -> tipped ones. */
function tippedArrowFor(price, arrowCount, outCount, maxUses = 12, xp = 30) {
  return {
    kind: 'tipped_arrow', id: 'tipped_arrow', item: 'tipped_arrow', price,
    inItem: 'arrow', inCount: arrowCount, count: outCount, maxUses, xp, priceMultiplier: 0.05,
    roll(r) {
      const pool = tippedPotions();
      const potion = pool[r.int(pool.length)];
      const s = mkStack(tippedArrowItem(potion), outCount, { potion });
      return offer(mkStack('emerald', price), mkStack('arrow', arrowCount), s, maxUses, xp, 0.05);
    },
  };
}

/** A boat of a random wood type. */
function boatFor(price, maxUses = 12, xp = 1) {
  return {
    kind: 'boat', id: 'boat', item: 'oak_boat', price, count: 1, maxUses, xp, priceMultiplier: 0.05,
    roll(r) {
      const wood = BOAT_WOODS[r.int(BOAT_WOODS.length)];
      return offer(mkStack('emerald', price), null, mkStack(wood + '_boat', 1), maxUses, xp, 0.05);
    },
  };
}

/** Expands a listing factory across all 16 dye colours. */
const perColor = (fn) => DYE_COLORS.map((c) => fn(c));

// ---------------------------------------------------------------------------
// The profession registry
// ---------------------------------------------------------------------------

/** 'farmer' -> { name, display, workstation, trades: [tier][] }. */
export const PROFESSIONS = {};
/** Every profession name, including `nitwit` and `unemployed`. */
export const PROFESSION_NAMES = [];
/** The 13 professions a villager can actually take by claiming a workstation. */
export const EMPLOYABLE_PROFESSIONS = [];
/** Block name -> profession name. */
export const WORKSTATION_PROFESSION = {};
/** Profession name -> workstation block name (null for nitwit/unemployed). */
export const WORKSTATIONS = {};

/**
 * Registers a profession. `tiers` is a 5-element array of listing pools, one
 * per level; missing tiers become empty pools.
 */
function defineProfession(name, workstation, tiers, opts = {}) {
  const trades = [];
  for (let i = 0; i < MAX_VILLAGER_LEVEL; i++) trades.push((tiers && tiers[i]) ? tiers[i].slice() : []);
  const def = {
    name,
    display: opts.display || prettyName(name),
    workstation: workstation || null,
    employable: !!workstation,
    trades,
    hat: !!opts.hat,
  };
  PROFESSIONS[name] = def;
  PROFESSION_NAMES.push(name);
  WORKSTATIONS[name] = def.workstation;
  if (workstation) {
    EMPLOYABLE_PROFESSIONS.push(name);
    WORKSTATION_PROFESSION[workstation] = name;
  }
  return def;
}

// ---- farmer ---------------------------------------------------------------
defineProfession('farmer', 'composter', [
  [
    buyFor('wheat', 20, 16, 2),
    buyFor('potato', 26, 16, 2),
    buyFor('carrot', 22, 16, 2),
    buyFor('beetroot', 15, 16, 2),
    sellFor('bread', 1, 6, 16, 1),
  ],
  [
    buyFor('pumpkin', 6, 12, 10),
    sellFor('pumpkin_pie', 1, 4, 12, 5),
    sellFor('apple', 1, 4, 16, 5),
  ],
  [
    sellFor('cookie', 3, 18, 12, 10),
    buyFor('melon', 4, 12, 20),
  ],
  [
    sellFor('cake', 1, 1, 12, 15),
    stewFor('night_vision', 100, 15),
    stewFor('jump_boost', 160, 15),
    stewFor('weakness', 140, 15),
    stewFor('blindness', 120, 15),
    stewFor('poison', 280, 15),
    stewFor('saturation', 7, 15),
  ],
  [
    sellFor('golden_carrot', 3, 3, 12, 30),
    sellFor('glistering_melon_slice', 4, 3, 12, 30),
  ],
], { hat: true });

// ---- fisherman ------------------------------------------------------------
defineProfession('fisherman', 'barrel', [
  [
    buyFor('string', 20, 16, 2),
    buyFor('coal', 10, 16, 2),
    convertFor('cod', 6, 'cooked_cod', 6, 1, 16, 1),
    sellFor('cod_bucket', 3, 1, 16, 1),
  ],
  [
    buyFor('cod', 15, 16, 10),
    convertFor('salmon', 6, 'cooked_salmon', 6, 1, 16, 5),
    sellFor('campfire', 2, 1, 12, 5),
  ],
  [
    buyFor('salmon', 13, 16, 20),
    enchantedFor('fishing_rod', 3, 3, 10),
  ],
  [
    buyFor('tropical_fish', 6, 12, 30),
    boatFor(1, 12, 30),
  ],
  [
    buyFor('pufferfish', 4, 12, 30),
  ],
]);

// ---- shepherd -------------------------------------------------------------
defineProfession('shepherd', 'loom', [
  [
    buyFor('white_wool', 18, 16, 2),
    buyFor('brown_wool', 18, 16, 2),
    buyFor('black_wool', 18, 16, 2),
    buyFor('gray_wool', 18, 16, 2),
    sellFor('shears', 2, 1, 12, 1),
  ],
  [
    ...perColor((c) => buyFor(c + '_dye', 12, 16, 10)),
    ...perColor((c) => sellFor(c + '_wool', 1, 1, 16, 5)),
    ...perColor((c) => sellFor(c + '_carpet', 1, 4, 16, 5)),
  ],
  [
    ...perColor((c) => buyFor(c + '_dye', 12, 16, 20)),
    ...perColor((c) => sellFor(c + '_bed', 3, 1, 12, 10)),
  ],
  [
    sellFor('painting', 2, 3, 12, 15),
  ],
  [
    ...perColor((c) => sellFor(c + '_banner', 3, 1, 12, 30)),
  ],
]);

// ---- fletcher -------------------------------------------------------------
defineProfession('fletcher', 'fletching_table', [
  [
    buyFor('stick', 32, 16, 2),
    sellFor('arrow', 1, 16, 16, 1),
    convertFor('gravel', 10, 'flint', 10, 1, 12, 1),
  ],
  [
    buyFor('flint', 26, 12, 10),
    sellFor('bow', 2, 1, 12, 5),
  ],
  [
    buyFor('string', 14, 16, 20),
    sellFor('crossbow', 3, 1, 12, 10),
  ],
  [
    buyFor('feather', 24, 16, 30),
    enchantedFor('bow', 2, 3, 15),
  ],
  [
    buyFor('tripwire_hook', 8, 12, 30),
    enchantedFor('crossbow', 3, 3, 15),
    tippedArrowFor(2, 5, 5, 12, 30),
  ],
]);

// ---- librarian ------------------------------------------------------------
defineProfession('librarian', 'lectern', [
  [
    buyFor('paper', 24, 16, 2),
    bookFor(1),
    sellFor('bookshelf', 9, 1, 12, 1),
  ],
  [
    buyFor('book', 4, 12, 10),
    bookFor(5),
    sellFor('lantern', 1, 1, 12, 5),
  ],
  [
    buyFor('ink_sac', 5, 12, 20),
    bookFor(10),
    sellFor('glass', 1, 4, 12, 10),
  ],
  [
    buyFor('writable_book', 2, 12, 30),
    bookFor(15),
    sellFor('clock', 5, 1, 12, 15),
    sellFor('compass', 4, 1, 12, 15),
  ],
  [
    sellFor('name_tag', 20, 1, 12, 30),
  ],
], { hat: true });

// ---- cartographer ---------------------------------------------------------
defineProfession('cartographer', 'cartography_table', [
  [
    buyFor('paper', 24, 16, 2),
    sellFor('map', 7, 1, 12, 1),
  ],
  [
    buyFor('glass_pane', 11, 16, 10),
    explorerMapFor('monument', 13, 12, 5),
  ],
  [
    buyFor('compass', 1, 12, 20),
    explorerMapFor('mansion', 14, 12, 10),
  ],
  [
    sellFor('item_frame', 7, 1, 12, 15),
    ...perColor((c) => sellFor(c + '_banner', 3, 1, 12, 15)),
  ],
  [
    sellFor('globe_banner_pattern', 8, 1, 12, 30),
  ],
], { hat: true });

// ---- cleric ---------------------------------------------------------------
defineProfession('cleric', 'brewing_stand', [
  [
    buyFor('rotten_flesh', 32, 16, 2),
    sellFor('redstone', 1, 2, 12, 1),
  ],
  [
    buyFor('gold_ingot', 3, 12, 10),
    sellFor('lapis_lazuli', 1, 1, 12, 5),
  ],
  [
    buyFor('rabbit_foot', 2, 12, 20),
    sellFor('glowstone', 4, 1, 12, 10),
  ],
  [
    buyFor('scute', 4, 12, 30),
    buyFor('glass_bottle', 9, 12, 30),
    sellFor('ender_pearl', 5, 1, 12, 15),
  ],
  [
    buyFor('nether_wart', 22, 12, 30),
    sellFor('experience_bottle', 3, 1, 12, 30),
  ],
], { hat: true });

// ---- armorer --------------------------------------------------------------
defineProfession('armorer', 'blast_furnace', [
  [
    buyFor('coal', 15, 16, 2),
    sellFor('iron_leggings', 7, 1, 12, 1),
    sellFor('iron_boots', 4, 1, 12, 1),
    sellFor('iron_helmet', 5, 1, 12, 1),
    sellFor('iron_chestplate', 9, 1, 12, 1),
  ],
  [
    buyFor('iron_ingot', 4, 12, 10),
    sellFor('bell', 36, 1, 12, 5),
    sellFor('chainmail_boots', 1, 1, 12, 5),
    sellFor('chainmail_leggings', 3, 1, 12, 5),
  ],
  [
    buyFor('lava_bucket', 1, 12, 20),
    buyFor('diamond', 1, 12, 20),
    sellFor('chainmail_helmet', 1, 1, 12, 10),
    sellFor('chainmail_chestplate', 4, 1, 12, 10),
    sellFor('shield', 5, 1, 12, 10),
  ],
  [
    enchantedFor('diamond_leggings', 14, 3, 15),
    enchantedFor('diamond_boots', 8, 3, 15),
  ],
  [
    enchantedFor('diamond_helmet', 8, 3, 30),
    enchantedFor('diamond_chestplate', 16, 3, 30),
  ],
]);

// ---- weaponsmith ----------------------------------------------------------
defineProfession('weaponsmith', 'grindstone', [
  [
    buyFor('coal', 15, 16, 2),
    sellFor('iron_axe', 3, 1, 12, 1),
    enchantedFor('iron_sword', 2, 12, 1),
  ],
  [
    buyFor('iron_ingot', 4, 12, 10),
    sellFor('bell', 36, 1, 12, 5),
  ],
  [
    buyFor('flint', 24, 12, 20),
  ],
  [
    buyFor('diamond', 1, 12, 30),
    enchantedFor('diamond_axe', 12, 3, 15),
  ],
  [
    enchantedFor('diamond_sword', 8, 3, 30),
  ],
]);

// ---- toolsmith ------------------------------------------------------------
defineProfession('toolsmith', 'smithing_table', [
  [
    buyFor('coal', 15, 16, 2),
    sellFor('stone_axe', 1, 1, 12, 1),
    sellFor('stone_shovel', 1, 1, 12, 1),
    sellFor('stone_pickaxe', 1, 1, 12, 1),
    sellFor('stone_hoe', 1, 1, 12, 1),
  ],
  [
    buyFor('iron_ingot', 4, 12, 10),
    sellFor('bell', 36, 1, 12, 5),
  ],
  [
    buyFor('flint', 30, 12, 20),
    enchantedFor('iron_axe', 1, 3, 10),
    enchantedFor('iron_shovel', 2, 3, 10),
    enchantedFor('iron_pickaxe', 3, 3, 10),
    sellFor('diamond_hoe', 4, 1, 3, 10),
  ],
  [
    buyFor('diamond', 1, 12, 30),
    enchantedFor('diamond_axe', 12, 3, 15),
    enchantedFor('diamond_shovel', 5, 3, 15),
  ],
  [
    enchantedFor('diamond_pickaxe', 13, 3, 30),
  ],
]);

// ---- butcher --------------------------------------------------------------
defineProfession('butcher', 'smoker', [
  [
    buyFor('chicken', 14, 16, 2),
    buyFor('porkchop', 7, 16, 2),
    buyFor('rabbit', 4, 16, 2),
    sellFor('rabbit_stew', 1, 1, 12, 1),
  ],
  [
    buyFor('coal', 15, 16, 2),
    sellFor('cooked_porkchop', 1, 5, 16, 5),
    sellFor('cooked_chicken', 1, 8, 16, 5),
  ],
  [
    buyFor('mutton', 7, 16, 20),
    buyFor('beef', 10, 16, 20),
  ],
  [
    buyFor('dried_kelp_block', 10, 12, 30),
  ],
  [
    buyFor('sweet_berries', 10, 12, 30),
  ],
]);

// ---- leatherworker --------------------------------------------------------
defineProfession('leatherworker', 'cauldron', [
  [
    buyFor('leather', 6, 16, 2),
    dyedFor('leather_leggings', 3, 12, 1),
    dyedFor('leather_chestplate', 7, 12, 1),
  ],
  [
    buyFor('flint', 26, 12, 10),
    dyedFor('leather_helmet', 5, 12, 5),
    dyedFor('leather_boots', 4, 12, 5),
  ],
  [
    buyFor('rabbit_hide', 9, 12, 20),
    dyedFor('leather_chestplate', 7, 12, 10),
  ],
  [
    buyFor('scute', 4, 12, 30),
    sellFor('leather_horse_armor', 6, 1, 12, 15),
  ],
  [
    sellFor('saddle', 6, 1, 12, 30),
    dyedFor('leather_helmet', 5, 12, 30),
  ],
]);

// ---- mason ----------------------------------------------------------------
defineProfession('mason', 'stonecutter', [
  [
    buyFor('clay_ball', 10, 16, 2),
    sellFor('brick', 1, 10, 16, 1),
  ],
  [
    buyFor('stone', 20, 16, 10),
    sellFor('chiseled_stone_bricks', 1, 4, 16, 5),
  ],
  [
    buyFor('granite', 16, 16, 20),
    buyFor('andesite', 16, 16, 20),
    buyFor('diorite', 16, 16, 20),
    sellFor('dripstone_block', 1, 4, 12, 10),
    sellFor('polished_andesite', 1, 4, 16, 10),
    sellFor('polished_diorite', 1, 4, 16, 10),
    sellFor('polished_granite', 1, 4, 16, 10),
  ],
  [
    buyFor('quartz', 12, 12, 30),
    ...perColor((c) => sellFor(c + '_terracotta', 1, 1, 12, 15)),
    ...perColor((c) => sellFor(c + '_glazed_terracotta', 1, 1, 12, 15)),
  ],
  [
    sellFor('quartz_pillar', 1, 1, 12, 30),
    sellFor('quartz_block', 1, 1, 12, 30),
  ],
]);

// ---- the two jobless professions -----------------------------------------
defineProfession('nitwit', null, []);
defineProfession('unemployed', null, []);

// ---------------------------------------------------------------------------
// The wandering trader's own two pools
// ---------------------------------------------------------------------------

/** Wandering trader tier 1 - five of these are offered. */
const WANDERING_TIER_1 = [
  sellFor('sea_pickle', 2, 1, 5, 1),
  sellFor('slimeball', 4, 1, 5, 1),
  sellFor('glowstone', 2, 1, 5, 1),
  sellFor('nautilus_shell', 5, 1, 5, 1),
  sellFor('fern', 1, 1, 12, 1),
  sellFor('sugar_cane', 1, 1, 8, 1),
  sellFor('pumpkin', 1, 1, 4, 1),
  sellFor('kelp', 3, 1, 12, 1),
  sellFor('cactus', 3, 1, 8, 1),
  sellFor('dandelion', 1, 1, 12, 1),
  sellFor('poppy', 1, 1, 12, 1),
  sellFor('blue_orchid', 1, 1, 8, 1),
  sellFor('allium', 1, 1, 12, 1),
  sellFor('azure_bluet', 1, 1, 12, 1),
  sellFor('red_tulip', 1, 1, 12, 1),
  sellFor('orange_tulip', 1, 1, 12, 1),
  sellFor('white_tulip', 1, 1, 12, 1),
  sellFor('pink_tulip', 1, 1, 12, 1),
  sellFor('oxeye_daisy', 1, 1, 12, 1),
  sellFor('cornflower', 1, 1, 12, 1),
  sellFor('lily_of_the_valley', 1, 1, 7, 1),
  sellFor('wheat_seeds', 1, 1, 12, 1),
  sellFor('beetroot_seeds', 1, 1, 12, 1),
  sellFor('pumpkin_seeds', 1, 1, 12, 1),
  sellFor('melon_seeds', 1, 1, 12, 1),
  sellFor('acacia_sapling', 5, 1, 8, 1),
  sellFor('birch_sapling', 5, 1, 8, 1),
  sellFor('dark_oak_sapling', 5, 1, 8, 1),
  sellFor('jungle_sapling', 5, 1, 8, 1),
  sellFor('oak_sapling', 5, 1, 8, 1),
  sellFor('spruce_sapling', 5, 1, 8, 1),
  sellFor('cherry_sapling', 5, 1, 8, 1),
  sellFor('mangrove_propagule', 5, 1, 8, 1),
  ...perColor((c) => sellFor(c + '_dye', 1, 3, 12, 1)),
  sellFor('vine', 1, 1, 12, 1),
  sellFor('red_mushroom', 1, 1, 12, 1),
  sellFor('brown_mushroom', 1, 1, 12, 1),
  sellFor('lily_pad', 1, 2, 5, 1),
  sellFor('small_dripleaf', 1, 2, 5, 1),
  sellFor('sand', 1, 8, 8, 1),
  sellFor('red_sand', 1, 4, 6, 1),
  sellFor('pointed_dripstone', 1, 2, 5, 1),
  sellFor('rooted_dirt', 1, 2, 5, 1),
  sellFor('moss_block', 1, 2, 5, 1),
  sellFor('mycelium', 1, 1, 5, 1),
];

/** Wandering trader tier 2 - exactly one of these is offered. */
const WANDERING_TIER_2 = [
  sellFor('tropical_fish_bucket', 5, 1, 4, 1),
  sellFor('pufferfish_bucket', 5, 1, 4, 1),
  sellFor('packed_ice', 3, 1, 6, 1),
  sellFor('blue_ice', 6, 1, 6, 1),
  sellFor('gunpowder', 1, 1, 8, 1),
  sellFor('podzol', 3, 3, 6, 1),
];

/** Read-only view of the wandering trader's pools, mostly for the UI/debug. */
export const WANDERING_TRADER_POOLS = Object.freeze([WANDERING_TIER_1, WANDERING_TIER_2]);

// ---------------------------------------------------------------------------
// Rolling trades
// ---------------------------------------------------------------------------

/** Profession definition by name; unknown names fall back to `unemployed`. */
export function getProfession(name) {
  if (name && typeof name === 'object') name = name.profession || name.name;
  return PROFESSIONS[name] || null;
}

/** Human-readable profession name. */
export function professionDisplay(name) {
  const p = getProfession(name);
  return p ? p.display : prettyName(name || 'unemployed');
}

/** The block a villager of this profession works at, or null. */
export function workstationFor(profession) {
  const p = getProfession(profession);
  return p ? p.workstation : null;
}

/**
 * Which profession claims this workstation block.
 * Accepts a block name, a block definition or anything with a `.name`.
 */
export function professionForWorkstation(blockName) {
  if (!blockName) return null;
  const key = typeof blockName === 'string' ? blockName : (blockName.name || blockName.block || null);
  if (!key) return null;
  return WORKSTATION_PROFESSION[key] || null;
}

/** True when this profession actually has offers (nitwits and the jobless do not). */
export function hasTrades(profession) {
  const p = getProfession(profession);
  if (!p) return false;
  return p.trades.some((pool) => pool.length > 0);
}

/** 'novice' .. 'master' for level 1..5. */
export function tradeLevelName(level) {
  return TRADE_LEVELS[clamp((level | 0) - 1, 0, MAX_VILLAGER_LEVEL - 1)];
}

/** Villager xp needed to reach the next level, or Infinity at master. */
export function xpForNextLevel(level) {
  const l = clamp(level | 0, 1, MAX_VILLAGER_LEVEL);
  return l >= MAX_VILLAGER_LEVEL ? Infinity : LEVEL_XP[l];
}

/**
 * Picks `count` distinct listings out of one tier's pool and bakes them into
 * offers. Pools smaller than `count` are used whole, exactly like vanilla.
 */
export function rollTierTrades(profession, tier, rng = null, count = TRADES_PER_TIER) {
  const prof = getProfession(profession);
  const out = [];
  if (!prof) return out;
  const t = clamp(tier | 0, 1, MAX_VILLAGER_LEVEL);
  const pool = prof.trades[t - 1];
  if (!pool || !pool.length) return out;
  const r = wrapRng(rng);
  const n = Math.min(count | 0 || 1, pool.length);
  const idx = [];
  for (let i = 0; i < pool.length; i++) idx.push(i);
  // Partial Fisher-Yates: only the first `n` slots need to be settled.
  for (let i = 0; i < n; i++) {
    const j = i + r.int(idx.length - i);
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  idx.length = n;
  idx.sort((a, b) => a - b);      // keep the table's own ordering in the UI
  for (const i of idx) {
    const listing = pool[i];
    let trade = null;
    try { trade = listing.roll(r, t); } catch (e) { console.warn('[trading] listing failed', listing.id, e); }
    if (!trade) continue;
    trade.tier = t;
    trade.listing = listing.id;
    out.push(trade);
  }
  return out;
}

/**
 * Every offer a villager of this profession shows at `level`: two random
 * listings from each unlocked tier, novice first.
 * Returns `[{ buy, buyB, sell, maxUses, xp, ... }]` - an empty array for
 * nitwits, the unemployed and unknown professions.
 */
export function rollTrades(profession, level = 1, rng = null) {
  const prof = getProfession(profession);
  const out = [];
  if (!prof) return out;
  const r = wrapRng(rng);
  const top = clamp(level | 0 || 1, 1, MAX_VILLAGER_LEVEL);
  for (let t = 1; t <= top; t++) {
    const tier = rollTierTrades(prof.name, t, r);
    for (const trade of tier) out.push(trade);
  }
  return out;
}

/**
 * The wandering trader's offer list: five random items from its big tier-1
 * pool plus exactly one from the rarer tier-2 pool.
 */
export function wanderingTraderTrades(rng = null) {
  const r = wrapRng(rng);
  const out = [];
  const draw = (pool, count, tier) => {
    const idx = [];
    for (let i = 0; i < pool.length; i++) idx.push(i);
    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + r.int(idx.length - i);
      const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
    }
    idx.length = n;
    for (const i of idx) {
      const trade = pool[i].roll(r, tier);
      if (!trade) continue;
      trade.tier = tier;
      trade.listing = pool[i].id;
      trade.rewardXp = false;      // wandering traders never level up
      trade.xp = 0;
      out.push(trade);
    }
  };
  draw(WANDERING_TIER_1, 5, 1);
  draw(WANDERING_TIER_2, 1, 2);
  return out;
}

/**
 * Makes sure a villager has an offer list, rolling one on first demand.
 * Wandering traders get the wandering pools; everyone else their profession's.
 * Returns the array (possibly empty).
 */
export function ensureTrades(villager, rng = null) {
  if (!villager) return [];
  if (Array.isArray(villager.trades) && villager.trades.length) return villager.trades;
  const r = wrapRng(rng || villager.rng);
  if (villager.type === 'wandering_trader' || villager.profession === 'wandering_trader') {
    villager.trades = wanderingTraderTrades(r);
    return villager.trades;
  }
  const level = clamp(villager.villagerLevel | 0 || 1, 1, MAX_VILLAGER_LEVEL);
  villager.trades = rollTrades(villager.profession || 'unemployed', level, r);
  return villager.trades;
}

// ---------------------------------------------------------------------------
// Gossip and reputation
// ---------------------------------------------------------------------------

/** Stable key for a player inside a gossip table. */
function playerKey(player) {
  if (!player) return 'unknown';
  return String(player.uuid || player.playerId || player.name || player.id || 'player');
}

/** The gossip record a villager keeps about one player. */
function gossipFor(villager, player, create) {
  if (!villager) return null;
  let table = villager.gossip;
  if (!table) {
    if (!create) return null;
    table = Object.create(null);
    villager.gossip = table;
  }
  const key = playerKey(player);
  let rec = table[key];
  if (!rec && create) { rec = Object.create(null); table[key] = rec; }
  return rec || null;
}

/**
 * Records gossip about a player. `type` is a key of GOSSIP_TYPES; the stored
 * value saturates at that type's cap. Returns the new stored value.
 */
export function addGossip(villager, player, type, amount = 1) {
  const t = GOSSIP_TYPES[type];
  if (!t || !villager) return 0;
  const rec = gossipFor(villager, player, true);
  if (!rec) return 0;
  const v = clamp((rec[type] | 0) + (amount | 0), 0, t.max);
  rec[type] = v;
  return v;
}

/**
 * A villager's opinion of a player, roughly -500..+500 but in practice
 * somewhere in -100..+100. Positive means cheaper trades.
 */
export function villagerReputation(villager, player) {
  const rec = gossipFor(villager, player, false);
  if (!rec) return 0;
  let sum = 0;
  for (const key in rec) {
    const t = GOSSIP_TYPES[key];
    if (t) sum += t.weight * clamp(rec[key] | 0, 0, t.max);
  }
  return sum;
}

/** Ages one villager's gossip by a day. Empty records are dropped. */
export function decayGossip(villager) {
  const table = villager && villager.gossip;
  if (!table) return;
  for (const key in table) {
    const rec = table[key];
    let any = false;
    for (const g in rec) {
      const t = GOSSIP_TYPES[g];
      if (!t) { delete rec[g]; continue; }
      const v = Math.max(0, (rec[g] | 0) - t.decay);
      if (v > 0) { rec[g] = v; any = true; } else delete rec[g];
    }
    if (!any) delete table[key];
  }
}

/**
 * Villagers chat: `from` shares half of each gossip entry with `to`.
 * Used when two villagers meet, and by iron golems after a raid.
 */
export function shareGossip(from, to) {
  const src = from && from.gossip;
  if (!src || !to) return;
  if (!to.gossip) to.gossip = Object.create(null);
  for (const key in src) {
    const rec = src[key];
    let dst = to.gossip[key];
    if (!dst) { dst = Object.create(null); to.gossip[key] = dst; }
    for (const g in rec) {
      const t = GOSSIP_TYPES[g];
      if (!t) continue;
      const share = Math.floor((rec[g] | 0) / 2);
      if (share > 0) dst[g] = clamp((dst[g] | 0) + share, 0, t.max);
    }
  }
}

/** Hero of the Village level on a player, 0 when absent. */
function heroLevel(player) {
  if (!player) return 0;
  let lvl = 0;
  try { lvl = effectLevel(player, 'hero_of_the_village') | 0; } catch { lvl = 0; }
  const direct = player.heroOfTheVillage | 0;
  return Math.max(lvl, direct);
}

/**
 * How much cheaper this villager's goods are for this player, as a fraction of
 * the base price. Positive = a discount, negative = a mark-up.
 *
 * Two sources, both vanilla:
 *   * Hero of the Village knocks 30% off, +6.25% per extra level;
 *   * gossip reputation shifts the price by up to a quarter either way.
 */
export function tradeDiscount(villager, player) {
  if (!villager || !player) return 0;
  let d = 0;
  const hero = heroLevel(player);
  if (hero > 0) d += 0.3 + 0.0625 * (hero - 1);
  const rep = villagerReputation(villager, player);
  d += clamp(rep, -100, 100) / 400;
  return clamp(d, -1, 0.95);
}

/**
 * The number of primary-cost items this player must hand over right now.
 * Folds in demand (a trade that keeps selling out gets pricier) and the
 * discount above, then clamps to 1..stackSize. Caches the result on
 * `trade.price` so the UI can render without recomputing.
 */
export function tradePrice(trade, villager = null, player = null) {
  if (!trade || !trade.buy) return 0;
  const base = Math.max(1, trade.buy.count | 0);
  const demandAdd = Math.max(0, Math.floor(base * (trade.demand || 0) * (trade.priceMultiplier || 0)));
  const frac = villager && player ? tradeDiscount(villager, player) : 0;
  let cut = Math.round(base * frac);
  // Reputation alone rounds away on cheap trades, but Hero of the Village
  // always saves at least one item - same asymmetry as vanilla.
  if (frac > 0 && cut < 1 && villager && player && heroLevel(player) > 0) cut = 1;
  // Never clamp *below* the offer's own base cost, even for items the registry
  // marks unstackable - the offer already fits in its slot by construction.
  const cap = Math.max(base, maxStackOf(trade.buy.item));
  const price = clamp(base + demandAdd - cut, 1, cap);
  trade.price = price;
  trade.specialPrice = cut ? -cut : 0;    // negative = a discount, as in vanilla
  return price;
}

/** Refreshes `price`/`specialPrice` on every offer a villager has. */
export function applyDiscounts(villager, player) {
  const trades = villager && villager.trades;
  if (!Array.isArray(trades)) return;
  for (const t of trades) tradePrice(t, villager, player);
}

/** Clears the per-player price adjustments (the player walked away). */
export function clearDiscounts(villager) {
  const trades = villager && villager.trades;
  if (!Array.isArray(trades)) return;
  for (const t of trades) tradePrice(t);
}

// ---------------------------------------------------------------------------
// Inventory plumbing (tolerant of whatever shape the player's inventory has)
// ---------------------------------------------------------------------------

function inventoryOf(player) {
  return (player && (player.inventory || player.inv)) || null;
}

function invSize(inv) {
  if (typeof inv.size === 'number') return inv.size;
  if (Array.isArray(inv.slots)) return inv.slots.length;
  return 0;
}

function invGet(inv, i) {
  return typeof inv.get === 'function' ? inv.get(i) : (inv.slots ? inv.slots[i] : null);
}

function invSet(inv, i, s) {
  if (typeof inv.set === 'function') inv.set(i, s);
  else if (inv.slots) inv.slots[i] = s;
}

/** How many of `name` the player is carrying. */
export function countItem(player, name) {
  const inv = inventoryOf(player);
  if (!inv) return 0;
  if (typeof inv.count === 'function') return inv.count(name) | 0;
  let n = 0;
  const size = invSize(inv);
  for (let i = 0; i < size; i++) {
    const s = invGet(inv, i);
    if (s && s.item === name) n += s.count | 0;
  }
  return n;
}

/** Removes up to `count` of `name`. Returns how many were actually taken. */
function takeItem(player, name, count) {
  const inv = inventoryOf(player);
  if (!inv || count <= 0) return 0;
  if (typeof inv.removeItem === 'function') return inv.removeItem(name, count) | 0;
  let left = count;
  const size = invSize(inv);
  for (let i = 0; i < size && left > 0; i++) {
    const s = invGet(inv, i);
    if (!s || s.item !== name) continue;
    const take = Math.min(left, s.count | 0);
    s.count -= take;
    left -= take;
    if (s.count <= 0) invSet(inv, i, null);
  }
  return count - left;
}

/** Gives a stack to the player, dropping whatever does not fit. */
function giveOrDrop(player, s) {
  if (!s || !player) return;
  let left = s;
  if (typeof player.giveItem === 'function') left = player.giveItem(s);
  else {
    const inv = inventoryOf(player);
    if (inv && typeof inv.add === 'function') left = inv.add(s);
  }
  if (!left || !(left.count > 0)) return;
  if (typeof player.dropStack === 'function') { player.dropStack(left); return; }
  if (player.world) {
    withMod(() => import('../entity/itementity.js'),
      (m) => m.dropItem(player.world, player.x, player.y + 1, player.z, left, 0, 0.2, 0));
  }
}

/** Spawns experience orbs for the player near (x, y, z). */
function grantXp(player, amount, x, y, z) {
  if (amount <= 0) return;
  if (typeof player.addXP === 'function') { player.addXP(amount); return; }
  if (typeof player.giveXP === 'function') { player.giveXP(amount); return; }
  if (typeof player.addExperience === 'function') { player.addExperience(amount); return; }
  const world = player.world;
  if (!world) return;
  withMod(() => import('../entity/itementity.js'), (m) => m.dropXP(world, x, y, z, amount));
}

// ---------------------------------------------------------------------------
// Stock, levelling and the transaction
// ---------------------------------------------------------------------------

/** True when this offer still has stock. */
export function tradeInStock(trade) {
  return !!trade && !trade.disabled && (trade.uses | 0) < (trade.maxUses | 0);
}

/** True when the player is carrying everything this offer asks for. */
export function canAffordTrade(trade, villager, player) {
  if (!trade || !player) return false;
  const price = tradePrice(trade, villager, player);
  if (countItem(player, trade.buy.item) < price) return false;
  if (trade.buyB && trade.buyB.count > 0 && countItem(player, trade.buyB.item) < trade.buyB.count) return false;
  return true;
}

/** Stock + affordability in one call - what the UI greys the button out on. */
export function canUseTrade(villager, trade, player) {
  return tradeInStock(trade) && canAffordTrade(trade, villager, player);
}

/**
 * Refills a villager's stock. Offers that sold out get pricier (demand rises),
 * offers nobody touched drift back down, exactly like vanilla's
 * `MerchantOffer.updateDemand`.
 */
export function restockTrades(villager) {
  const trades = villager && villager.trades;
  if (!Array.isArray(trades)) return false;
  for (const t of trades) {
    t.demand = (t.demand || 0) + (t.uses | 0) - ((t.maxUses | 0) - (t.uses | 0));
    if (t.demand < 0) t.demand = 0;
    t.uses = 0;
    t.disabled = false;
  }
  if (villager) villager.restockTimer = RESTOCK_INTERVAL;
  return true;
}

/**
 * Adds villager xp, unlocking tiers as the thresholds are crossed and rolling
 * the new tier's offers onto the end of the list.
 * Returns the number of levels gained.
 */
export function addVillagerXp(villager, xp, rng = null) {
  if (!villager || !xp) return 0;
  const prof = getProfession(villager.profession);
  if (!prof || !prof.employable) return 0;
  villager.villagerXp = (villager.villagerXp | 0) + (xp | 0);
  if (!villager.villagerLevel) villager.villagerLevel = 1;
  const r = wrapRng(rng || villager.rng);
  let gained = 0;
  while (villager.villagerLevel < MAX_VILLAGER_LEVEL
    && villager.villagerXp >= LEVEL_XP[villager.villagerLevel]) {
    villager.villagerLevel++;
    gained++;
    if (!Array.isArray(villager.trades)) villager.trades = [];
    const extra = rollTierTrades(prof.name, villager.villagerLevel, r);
    for (const t of extra) villager.trades.push(t);
  }
  return gained;
}

/**
 * Spends one use of an offer.
 *
 * Checks stock and the player's items, moves the goods, bumps the offer's use
 * counter, records trading gossip, hands the player experience orbs and awards
 * the villager its trade xp - levelling it up (and unlocking a fresh tier of
 * offers) when a threshold is crossed.
 *
 * Returns true when the trade actually happened.
 */
export function useTrade(villager, trade, player) {
  if (!villager || !trade || !player) return false;
  if (!tradeInStock(trade)) return false;

  const price = tradePrice(trade, villager, player);
  const second = trade.buyB && trade.buyB.count > 0 ? trade.buyB : null;
  if (countItem(player, trade.buy.item) < price) return false;
  if (second && countItem(player, second.item) < second.count) return false;

  // Move the goods. Trading consumes items in every game mode, like vanilla.
  if (takeItem(player, trade.buy.item, price) < price) return false;
  if (second) takeItem(player, second.item, second.count);
  giveOrDrop(player, copyTradeStack(trade.sell));

  trade.uses = (trade.uses | 0) + 1;
  if (trade.uses >= trade.maxUses) trade.disabled = true;

  const x = villager.x ?? player.x, y = (villager.y ?? player.y), z = villager.z ?? player.z;
  const isWanderer = villager.type === 'wandering_trader';

  // Reputation: two points of trading gossip per completed trade.
  addGossip(villager, player, 'trading', 2);

  // Player experience: 3..6 orbs, unless the offer is xp-free (traders).
  if (trade.rewardXp !== false) {
    const r = wrapRng(villager.rng);
    grantXp(player, TRADE_XP_MIN + r.int(TRADE_XP_SPREAD), x, y + 0.5, z);
  }

  // Villager progression.
  let levels = 0;
  if (!isWanderer && trade.xp) levels = addVillagerXp(villager, trade.xp, villager.rng);
  villager.lastTradeTick = villager.world ? (villager.world.totalTime | 0) : (Game.ticks | 0);
  villager.tradedWithPlayer = true;

  if (levels > 0) {
    // Levelling up unlocks a fresh tier but deliberately does NOT refill the
    // old offers - only the workstation restock does that, as in vanilla.
    if (typeof villager.addEffect === 'function') {
      try { villager.addEffect('regeneration', 200, 0); } catch { /* optional */ }
    }
    particles('happy_villager', x, y + 1.4, z, { count: 12, spread: 0.5 });
    playAt(x, y, z, 'villager_celebrate', 1, 1);
    playAt(x, y, z, 'level_up', 0.6, 1.2);
  } else {
    particles('happy_villager', x, y + 1.4, z, { count: 4, spread: 0.4 });
    playAt(x, y, z, isWanderer ? 'wandering_trader_yes' : 'villager_yes', 1, 1);
  }

  Game.emit('trade', villager, trade, player);
  return true;
}

/** The "villager shakes its head" response for an offer the player cannot take. */
export function refuseTrade(villager, player) {
  if (!villager) return false;
  const x = villager.x ?? 0, y = villager.y ?? 0, z = villager.z ?? 0;
  playAt(x, y, z, villager.type === 'wandering_trader' ? 'wandering_trader_no' : 'villager_no', 1, 1);
  particles('angry_villager', x, y + 1.4, z, { count: 3, spread: 0.3 });
  return false;
}

// ---------------------------------------------------------------------------
// Presentation helpers for the trading screen
// ---------------------------------------------------------------------------

/** `{ level, name, xp, need, progress }` for the villager's level bar. */
export function levelProgress(villager) {
  const level = clamp(villager?.villagerLevel | 0 || 1, 1, MAX_VILLAGER_LEVEL);
  const xp = villager?.villagerXp | 0;
  const floor = LEVEL_XP[level - 1] || 0;
  const need = xpForNextLevel(level);
  const span = need === Infinity ? 0 : Math.max(1, need - floor);
  return {
    level,
    name: tradeLevelName(level),
    xp,
    need: need === Infinity ? 0 : need,
    progress: span ? clamp((xp - floor) / span, 0, 1) : 1,
  };
}

/** Display name for a stack, honouring the overrides trades bake in. */
export function tradeStackName(s) {
  if (!s) return '';
  if (s.display) return s.display;
  const d = getItem(s.item);
  return d ? d.display : prettyName(s.item);
}

/** One-line summary of an offer, e.g. "20 Wheat -> 1 Emerald". */
export function describeTrade(trade, villager = null, player = null) {
  if (!trade) return '';
  const price = tradePrice(trade, villager, player);
  const left = price + ' ' + tradeStackName(trade.buy)
    + (trade.buyB ? ' + ' + trade.buyB.count + ' ' + tradeStackName(trade.buyB) : '');
  return left + ' → ' + trade.sell.count + ' ' + tradeStackName(trade.sell);
}

/** Serialises a villager's offers for save.js. */
export function serializeTrades(trades) {
  if (!Array.isArray(trades)) return null;
  return trades.map((t) => ({
    buy: t.buy, buyB: t.buyB, sell: t.sell,
    maxUses: t.maxUses, uses: t.uses, xp: t.xp,
    priceMultiplier: t.priceMultiplier, demand: t.demand,
    disabled: t.disabled, rewardXp: t.rewardXp, tier: t.tier, listing: t.listing,
  }));
}

/** Rebuilds offers loaded from a save file. */
export function deserializeTrades(data) {
  if (!Array.isArray(data)) return null;
  return data.map((d) => {
    const t = offer(d.buy, d.buyB, d.sell, d.maxUses | 0 || 12, d.xp | 0,
      d.priceMultiplier !== undefined ? d.priceMultiplier : 0.05);
    t.uses = d.uses | 0;
    t.demand = d.demand | 0;
    t.disabled = !!d.disabled;
    t.rewardXp = d.rewardXp !== false;
    t.tier = d.tier | 0 || 1;
    t.listing = d.listing || null;
    return t;
  });
}

/** Total listings registered across every profession - handy for validation. */
export const TRADE_LISTING_COUNT = PROFESSION_NAMES
  .reduce((n, p) => n + PROFESSIONS[p].trades.reduce((m, pool) => m + pool.length, 0), 0)
  + WANDERING_TIER_1.length + WANDERING_TIER_2.length;

export default PROFESSIONS;
