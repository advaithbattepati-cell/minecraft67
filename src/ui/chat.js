// ============================================================================
// chat.js - The chat log and the slash-command console.
//
// Two halves that share one DOM layer (#chat-layer):
//
//   * the LOG. Up to 100 lines are kept; while the input is shut only the last
//     10 are on screen and each fades out ten seconds after it arrived. While
//     the input is open every line comes back and the wheel scrolls the whole
//     scrollback. Lines understand the vanilla section-sign codes (colours plus
//     bold/italic/underline/strike/obfuscated) and turn "x, y, z" triples into
//     clickable teleport links.
//
//   * the INPUT. Opened with T (empty) or / (prefilled). It is a real <input>,
//     which is what makes key capture work: core/input.js deliberately ignores
//     every key while a text field owns the focus, so the player cannot walk,
//     mine or open the inventory while typing. Tab completes command names and
//     arguments, the arrows walk the suggestion list or the sent-message
//     history, Enter sends and Escape closes.
//
// Everything below the Chat class is the command layer: a small registry
// (COMMANDS), an argument parser that understands ~relative and ^local
// coordinates, and one entry per command with real feedback.
//
// Cross-module policy: only core/ is imported statically. Every registry this
// file consults (blocks, items, mobs, effects, enchantments, structures,
// sounds) is pulled in lazily and every call site tolerates its absence, so a
// half-built sibling module can never take the chat down with it.
// ============================================================================
import { Game } from '../core/game.js';
import {
  GAMEMODE, DIFFICULTY, DIM_OVERWORLD, DIM_NETHER, DIM_END,
  WORLD_HEIGHT, SEA_LEVEL, TICKS_PER_SECOND,
  TIME_DAY, TIME_NOON, TIME_SUNSET, TIME_NIGHT, TIME_MIDNIGHT, TIME_SUNRISE,
  MAX_HUNGER, MAX_AIR,
} from '../core/constants.js';
import { clamp, prettyName, formatTime } from '../core/util.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MAX_LINES = 100;        // scrollback kept in the DOM
const VISIBLE_LINES = 10;     // lines shown while the input is shut
const FADE_AFTER = 10;        // seconds before a line starts fading
const FADE_TIME = 0.7;        // matches the .chat-line opacity transition
const MAX_HISTORY = 100;
const MAX_SUGGESTIONS = 10;   // rows drawn in the suggestion popup
const CONFIRM_FILL = 32768;   // /fill asks before changing more than this
const MAX_FILL = 524288;      // and refuses outright above this
const OPEN_GUARD_MS = 90;     // window in which the opening keystroke is eaten

// ---------------------------------------------------------------------------
// Lazily-grabbed siblings. Registries only; nothing here is required to boot.
// ---------------------------------------------------------------------------
const M = {
  blocks: null, items: null, inventory: null, mobs: null, effects: null,
  enchanting: null, structures: null, lighting: null, sound: null,
  itemrender: null, models: null, biomes: null,
};
let _depsStarted = false;

/** Starts loading every optional registry. Safe to call more than once. */
function ensureDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, key) => {
    try {
      import(path).then((m) => { M[key] = m; }).catch(() => { /* optional */ });
    } catch { /* import() unsupported */ }
  };
  grab('../world/blocks.js', 'blocks');
  grab('../item/items.js', 'items');
  grab('../item/inventory.js', 'inventory');
  grab('../entity/mobs.js', 'mobs');
  grab('../item/effects.js', 'effects');
  grab('../item/enchanting.js', 'enchanting');
  grab('../world/structures.js', 'structures');
  grab('../world/lighting.js', 'lighting');
  grab('../audio/sound.js', 'sound');
  grab('../render/itemrender.js', 'itemrender');
  grab('../render/models.js', 'models');
  grab('../world/biomes.js', 'biomes');
}

// Start the fetches as soon as this module is evaluated: no Game field is
// touched, and by the time a player types a command they are long since in.
ensureDeps();

/** The live Chat instance, so module-level command bodies can talk back. */
let ACTIVE = null;

// ---------------------------------------------------------------------------
// Tiny DOM + formatting helpers
// ---------------------------------------------------------------------------
function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

/** 12.3456 -> "12.35", 12 -> "12". Keeps chat coordinates readable. */
function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}
const fmtPos = (x, y, z) => `${fmt(x)}, ${fmt(y)}, ${fmt(z)}`;

/** "diamond_sword" -> "Diamond Sword", using the item registry when present. */
function itemDisplay(name) {
  const d = M.items && typeof M.items.getItem === 'function' ? M.items.getItem(name) : null;
  return (d && d.display) || prettyName(name);
}
function blockDisplay(name) {
  const d = M.blocks && typeof M.blocks.blockByName === 'function' ? M.blocks.blockByName(name) : null;
  return (d && d.display) || prettyName(name);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
// Null-prototype so a stray "constructor" or "toString" cannot be mistaken
// for a colour code.
const COLOR_CODES = Object.assign(Object.create(null), {
  0: 'black', 1: 'dark_blue', 2: 'dark_green', 3: 'dark_aqua', 4: 'dark_red',
  5: 'dark_purple', 6: 'gold', 7: 'gray', 8: 'dark_gray', 9: 'blue',
  a: 'green', b: 'aqua', c: 'red', d: 'light_purple', e: 'yellow', f: 'white',
});
const STYLE_CODES = Object.assign(Object.create(null), {
  l: 'mc-bold', o: 'mc-italic', n: 'mc-under', m: 'mc-strike', k: 'mc-obf',
});
const COLOR_NAMES = new Set(Object.values(COLOR_CODES));
/** Line kinds style.css already knows about. */
const LINE_KINDS = new Set(['system', 'error', 'whisper', 'dim']);

/** Applies a `color` argument: a §-name, a line kind, a hex number or any CSS colour. */
function applyColorTo(node, color) {
  if (color == null || color === '') return;
  if (typeof color === 'number' && Number.isFinite(color)) {
    node.style.color = '#' + ((color >>> 0) & 0xffffff).toString(16).padStart(6, '0');
    return;
  }
  const c = String(color).trim().toLowerCase();
  if (!c) return;
  if (COLOR_NAMES.has(c)) node.classList.add('mc-c-' + c);
  else if (LINE_KINDS.has(c)) node.classList.add(c);
  else if (COLOR_CODES[c]) node.classList.add('mc-c-' + COLOR_CODES[c]);
  else node.style.color = c;
}

// "12, 64, -30" and "(12, 64, -30)" become teleport links.
const COORD_RE = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;

/** Appends `text` to `parent`, wrapping coordinate triples in clickable spans. */
function appendWithCoords(parent, text, className, chat) {
  const host = className ? el('span', className) : parent;
  COORD_RE.lastIndex = 0;
  let last = 0;
  let m = COORD_RE.exec(text);
  while (m) {
    if (m.index > last) host.appendChild(document.createTextNode(text.slice(last, m.index)));
    const link = el('span', 'clickable mc-c-aqua mc-under');
    link.textContent = m[0];
    link.title = 'Click to teleport here';
    const x = m[1], y = m[2], z = m[3];
    link.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const c = chat || ACTIVE;
      if (c) c.runCommand(`/tp ${x} ${y} ${z}`);
    });
    host.appendChild(link);
    last = m.index + m[0].length;
    m = COORD_RE.exec(text);
  }
  if (last < text.length) host.appendChild(document.createTextNode(text.slice(last)));
  if (host !== parent) parent.appendChild(host);
}

/** Parses §-codes into styled spans and fills `node`. */
function renderRich(node, text, chat) {
  const src = String(text == null ? '' : text);
  let colorCls = '';
  let styleCls = '';
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const cls = (colorCls + ' ' + styleCls).trim();
    appendWithCoords(node, buf, cls, chat);
    buf = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '§' && i + 1 < src.length) {
      const code = src[i + 1].toLowerCase();
      if (COLOR_CODES[code]) { flush(); colorCls = 'mc-c-' + COLOR_CODES[code]; styleCls = ''; i++; continue; }
      if (STYLE_CODES[code]) { flush(); styleCls = (styleCls ? styleCls + ' ' : '') + STYLE_CODES[code]; i++; continue; }
      if (code === 'r') { flush(); colorCls = ''; styleCls = ''; i++; continue; }
    }
    buf += c;
  }
  flush();
  if (!node.firstChild) node.appendChild(document.createTextNode(''));
}

// ---------------------------------------------------------------------------
// Message helpers used by the commands
// ---------------------------------------------------------------------------
/** Writes a line to the live chat, or to the console log when there is none. */
function say(text, color) {
  if (ACTIVE) ACTIVE.addMessage(text, color);
  else if (Game && typeof Game.log === 'function') Game.log(String(text));
}
/** Plain white success feedback. Always returns true. */
function ok(text) { say(text); return true; }
/** Grey supporting detail. */
function info(text) { say(text, 'gray'); return true; }
/** Yellow warning / prompt. */
function warn(text) { say(text, 'system'); return false; }
/** Red failure. Always returns false so `return err(...)` reads well. */
function err(text) { say(text, 'error'); return false; }
/** "Usage: /give <item> [count]" straight from the registry. */
function usage(name) {
  const e = COMMANDS['/' + name];
  return err(`Usage: §e/${name}${e && e.args ? ' ' + e.args : ''}`);
}

// ---------------------------------------------------------------------------
// Name resolution: partial names, "did you mean", edit distance
// ---------------------------------------------------------------------------
function normalizeName(q) {
  return String(q == null ? '' : q).trim().toLowerCase()
    .replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
}

/** Bounded Levenshtein distance; bails out as soon as it exceeds `max`. */
function editDistance(a, b, max) {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let best = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + cost;
      const del = prev[j] + 1;
      if (del < v) v = del;
      const ins = cur[j - 1] + 1;
      if (ins < v) v = ins;
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[bl];
}

/** The `limit` closest names to `q` within `max` edits. */
function closestNames(q, list, max = 3, limit = 5) {
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const d = editDistance(q, list[i], max);
    if (d <= max) scored.push([d, list[i]]);
  }
  scored.sort((a, b) => (a[0] - b[0]) || (a[1].length - b[1].length));
  return scored.slice(0, limit).map((s) => s[1]);
}

/**
 * Resolves a possibly-partial registry name.
 * @returns {{name: string|null, matches: string[]}} `name` when it resolved
 *          unambiguously, otherwise a handful of things the player may have meant.
 */
function resolveName(list, query) {
  const out = { name: null, matches: [] };
  const q = normalizeName(query);
  if (!q || !list || !list.length) return out;
  const prefix = [];
  const sub = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n === q) { out.name = n; return out; }
    if (n.startsWith(q)) prefix.push(n);
    else if (n.indexOf(q) >= 0) sub.push(n);
  }
  if (prefix.length === 1) { out.name = prefix[0]; return out; }
  if (!prefix.length && sub.length === 1) { out.name = sub[0]; return out; }
  if (prefix.length) { prefix.sort((a, b) => a.length - b.length); out.matches = prefix.slice(0, 8); return out; }
  if (sub.length) { sub.sort((a, b) => a.length - b.length); out.matches = sub.slice(0, 8); return out; }
  out.matches = closestNames(q, list, 3, 5);
  return out;
}

/** " Did you mean: a, b, c?" (empty when there is nothing to suggest). */
function suggestText(matches) {
  if (!matches || !matches.length) return '';
  return ` §7Did you mean: §f${matches.join('§7, §f')}§7?`;
}

// ---------------------------------------------------------------------------
// Registry accessors (all tolerate a module that has not loaded)
// ---------------------------------------------------------------------------
function itemNames() {
  const m = M.items;
  if (!m) return [];
  if (Array.isArray(m.ITEM_NAMES) && m.ITEM_NAMES.length) return m.ITEM_NAMES;
  return m.ITEMS ? Object.keys(m.ITEMS) : [];
}
function blockNames() {
  const m = M.blocks;
  if (!m) return [];
  if (Array.isArray(m.BLOCK_NAMES) && m.BLOCK_NAMES.length) return m.BLOCK_NAMES;
  if (m.BLOCK_BY_NAME && typeof m.BLOCK_BY_NAME.keys === 'function') return [...m.BLOCK_BY_NAME.keys()];
  return [];
}
function mobNames() {
  const m = M.mobs;
  if (!m) return [];
  if (Array.isArray(m.MOB_NAMES) && m.MOB_NAMES.length) return m.MOB_NAMES;
  return m.MOBS ? Object.keys(m.MOBS) : [];
}
function effectNames() {
  const m = M.effects;
  if (!m) return [];
  if (Array.isArray(m.EFFECT_NAMES) && m.EFFECT_NAMES.length) return m.EFFECT_NAMES;
  return m.EFFECTS ? Object.keys(m.EFFECTS) : [];
}
function enchantNames() {
  const m = M.enchanting;
  if (!m) return [];
  if (Array.isArray(m.ENCHANTMENT_NAMES) && m.ENCHANTMENT_NAMES.length) return m.ENCHANTMENT_NAMES;
  return m.ENCHANTMENTS ? Object.keys(m.ENCHANTMENTS) : [];
}
function structureNames() {
  const m = M.structures;
  if (!m) return [];
  if (Array.isArray(m.STRUCTURE_NAMES) && m.STRUCTURE_NAMES.length) return m.STRUCTURE_NAMES;
  if (m.STRUCTURES && typeof m.STRUCTURES.keys === 'function') return [...m.STRUCTURES.keys()];
  return [];
}
function soundNames() {
  const m = M.sound;
  if (!m) return [];
  if (Array.isArray(m.SOUND_NAMES) && m.SOUND_NAMES.length) return m.SOUND_NAMES;
  return m.SOUNDS ? Object.keys(m.SOUNDS) : [];
}
function gameRuleNames() {
  const w = Game.world;
  const base = w && w.gameRules ? Object.keys(w.gameRules) : [
    'doDaylightCycle', 'doWeatherCycle', 'doMobSpawning', 'doFireTick',
    'mobGriefing', 'keepInventory', 'doTileDrops',
  ];
  return base.concat(['randomTickSpeed']);
}
function playerNames() {
  const names = [];
  const p = Game.player;
  if (p && p.name) names.push(p.name);
  const w = Game.world;
  if (w && typeof w.getPlayers === 'function') {
    try {
      for (const o of w.getPlayers()) if (o && o.name && names.indexOf(o.name) < 0) names.push(o.name);
    } catch { /* optional */ }
  }
  return names;
}

/** Particle type names, mirroring render/particles.js. */
const PARTICLE_NAMES = [
  'smoke', 'large_smoke', 'campfire_smoke', 'flame', 'lava', 'bubble', 'splash', 'rain',
  'crit', 'enchanted_hit', 'magic', 'enchant', 'heart', 'angry', 'note', 'portal',
  'explosion', 'cloud', 'dust', 'block', 'sweep', 'slime', 'snowball', 'firework',
  'spark', 'drip_water', 'drip_lava', 'drip_honey', 'soul', 'end_rod', 'totem', 'damage',
  'spore', 'cherry', 'glow', 'ash', 'snowflake', 'sculk', 'happy', 'flash',
  'crimson_spore', 'warped_spore', 'mycelium', 'dragon_breath',
];

const GAMEMODE_NAMES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTY_NAMES = ['peaceful', 'easy', 'normal', 'hard'];
const DIMENSION_NAMES = [DIM_OVERWORLD, DIM_NETHER, DIM_END];

/** Argument-type -> candidate list, used by tab completion. */
const ARG_SOURCES = Object.assign(Object.create(null), {
  item: itemNames,
  block: blockNames,
  mob: mobNames,
  effect: () => effectNames().concat(['clear']),
  enchant: enchantNames,
  structure: structureNames,
  gamerule: gameRuleNames,
  player: playerNames,
  particle: () => PARTICLE_NAMES,
  sound: soundNames,
  gamemode: () => GAMEMODE_NAMES,
  difficulty: () => DIFFICULTY_NAMES,
  dimension: () => DIMENSION_NAMES,
  weather: () => ['clear', 'rain', 'thunder'],
  timeop: () => ['set', 'add', 'query'],
  timeval: () => ['day', 'noon', 'sunset', 'night', 'midnight', 'sunrise'],
  toggle: () => ['on', 'off', 'toggle'],
  bool: () => ['true', 'false'],
  titleop: () => ['title', 'subtitle', 'actionbar', 'clear', 'times'],
  fillop: () => ['confirm', 'cancel'],
  target: () => ['@s', '@e', '@a', '@p'].concat(mobNames()),
  command: () => commandNames(),
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
/** Splits a command line, honouring "quoted strings". */
function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let had = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === '\'') { quote = c; had = true; continue; }
    if (c === ' ' || c === '\t') {
      if (cur || had) { out.push(cur); cur = ''; had = false; }
      continue;
    }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

function num(tok, dflt = NaN) {
  if (tok === undefined || tok === null || tok === '') return dflt;
  const n = Number(tok);
  return Number.isFinite(n) ? n : dflt;
}
function int(tok, dflt = NaN) {
  const n = num(tok, NaN);
  return Number.isFinite(n) ? Math.round(n) : dflt;
}

/** One coordinate token: "12", "~", "~-3". */
function relCoord(tok, base) {
  if (typeof tok !== 'string' || tok === '') return NaN;
  if (tok === '~') return base;
  if (tok[0] === '~') {
    const d = Number(tok.slice(1));
    return Number.isFinite(d) ? base + d : NaN;
  }
  const n = Number(tok);
  return Number.isFinite(n) ? n : NaN;
}

/** ^left ^up ^forward relative to where the entity is looking. */
function localToWorld(e, left, up, fwd) {
  const yaw = e ? (e.yaw || 0) : 0;
  const pitch = e ? (e.pitch || 0) : 0;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  // Vanilla look basis: forward (-sin y cos p, -sin p, cos y cos p), left (cos y, 0, sin y).
  const fx = -sy * cp, fy = -sp, fz = cy * cp;
  const lx = cy, ly = 0, lz = sy;
  // up = left x forward, so the frame stays right-handed at any pitch.
  const ux = ly * fz - lz * fy;
  const uy = lz * fx - lx * fz;
  const uz = lx * fy - ly * fx;
  const ox = e ? e.x : 0;
  const oy = e ? e.y + (e.eyeHeight || 0) : 0;
  const oz = e ? e.z : 0;
  return {
    x: ox + lx * left + ux * up + fx * fwd,
    y: oy + ly * left + uy * up + fy * fwd,
    z: oz + lz * left + uz * up + fz * fwd,
  };
}

/**
 * Reads three coordinate tokens starting at `i`. Understands plain numbers,
 * `~` relative and `^` local coordinates.
 * @returns {{x:number,y:number,z:number}|null}
 */
function parsePos(args, i, e) {
  const a = args[i], b = args[i + 1], c = args[i + 2];
  if (a === undefined || b === undefined || c === undefined) return null;
  const carets = (a[0] === '^' ? 1 : 0) + (b[0] === '^' ? 1 : 0) + (c[0] === '^' ? 1 : 0);
  if (carets) {
    if (carets !== 3) return null;
    const l = num(a.slice(1) || '0', NaN), u = num(b.slice(1) || '0', NaN), f = num(c.slice(1) || '0', NaN);
    if (!Number.isFinite(l) || !Number.isFinite(u) || !Number.isFinite(f)) return null;
    return localToWorld(e, l, u, f);
  }
  const x = relCoord(a, e ? e.x : 0);
  const y = relCoord(b, e ? e.y : 0);
  const z = relCoord(c, e ? e.z : 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/** Picks entities for /kill and friends. */
function selectEntities(token, player, world) {
  const out = [];
  if (!world || !Array.isArray(world.entities)) return out;
  const live = world.entities.filter((e) => e && !e.removed);
  const t = token === undefined ? '@s' : String(token).toLowerCase();

  if (t === '@s' || t === 'self' || t === 'me' || t === '@p') return player ? [player] : [];
  if (t === '@a' || t === 'players') return live.filter((e) => e.isPlayer);
  if (t === '@e' || t === 'all') return live;
  if (t === 'mobs' || t === '@m') return live.filter((e) => !e.isPlayer && e.type !== 'item' && e.type !== 'xp_orb');
  if (t === 'items' || t === 'drops') return live.filter((e) => e.type === 'item' || e.type === 'xp_orb');

  const sel = /^@e\[(.*)\]$/.exec(t);
  if (sel) {
    let type = null;
    let radius = Infinity;
    for (const part of sel[1].split(',')) {
      const kv = part.split('=');
      if (kv.length !== 2) continue;
      const k = kv[0].trim(), v = kv[1].trim();
      if (k === 'type') type = normalizeName(v);
      else if (k === 'r' || k === 'distance') radius = num(v, Infinity);
    }
    for (const e of live) {
      if (type && normalizeName(e.type) !== type) continue;
      if (player && Number.isFinite(radius)) {
        const dx = e.x - player.x, dy = e.y - player.y, dz = e.z - player.z;
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      }
      out.push(e);
    }
    return out;
  }

  const byName = normalizeName(t);
  for (const e of live) if (normalizeName(e.type) === byName) out.push(e);
  if (!out.length) for (const e of live) if (e.name && normalizeName(e.name) === byName) out.push(e);
  return out;
}

/** Nearest entity whose type matches, used by /tp <mob>. */
function nearestOfType(world, player, name) {
  const list = selectEntities(name, player, world).filter((e) => e !== player);
  if (!list.length) return null;
  let best = null, bestD = Infinity;
  for (const e of list) {
    const dx = e.x - player.x, dy = e.y - player.y, dz = e.z - player.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** Builds a stack without hard-depending on item/inventory.js. */
function mkStack(name, count, extra) {
  if (M.inventory && typeof M.inventory.stack === 'function') {
    try { return M.inventory.stack(name, count, extra || null); } catch { /* fall through */ }
  }
  if (!name || count <= 0) return null;
  const s = { item: name, count: Math.floor(count), damage: 0 };
  if (extra) Object.assign(s, extra);
  return s;
}

// ---------------------------------------------------------------------------
// The command registry
// ---------------------------------------------------------------------------
/** '/give' -> { name, args, desc, aliases, types, run(args, player) }. */
export const COMMANDS = {};
const ALIASES = new Map();

/**
 * Registers a slash command.
 * @param {string} name bare command name, no slash
 * @param {{args?:string, desc?:string, aliases?:string[], types?:string[],
 *          complete?:Function, needsPlayer?:boolean, run:Function}} def
 */
export function defineCommand(name, def) {
  const e = {
    name,
    args: def.args || '',
    desc: def.desc || '',
    aliases: def.aliases || [],
    types: def.types || null,
    complete: def.complete || null,
    needsPlayer: def.needsPlayer !== false,
    run: def.run,
  };
  COMMANDS['/' + name] = e;
  for (const a of e.aliases) ALIASES.set(a, name);
  return e;
}
const cmd = defineCommand;

/** Every registered command name, sorted. */
export function commandNames() {
  return Object.keys(COMMANDS).map((k) => k.slice(1)).sort();
}

/** Looks a command up by name or alias, with or without the leading slash. */
export function lookupCommand(name) {
  if (!name) return null;
  let n = String(name).toLowerCase();
  if (n[0] === '/') n = n.slice(1);
  const direct = COMMANDS['/' + n];
  if (direct) return direct;
  const alias = ALIASES.get(n);
  return alias ? COMMANDS['/' + alias] || null : null;
}

/** Candidate completions for argument `argIndex` (1 = first argument). */
function candidatesFor(entry, argIndex, args) {
  if (!entry || argIndex < 1) return [];
  if (typeof entry.complete === 'function') {
    try {
      const r = entry.complete(argIndex, args);
      if (Array.isArray(r)) return r;
    } catch { /* fall through to the declared types */ }
  }
  const t = entry.types && entry.types[argIndex - 1];
  if (!t) return [];
  const src = ARG_SOURCES[t];
  return src ? src() : [];
}

// ===========================================================================
// Commands
// ===========================================================================

// ---- /help ----------------------------------------------------------------
cmd('help', {
  args: '[page|command]', desc: 'Lists every command.', aliases: ['?'],
  types: ['command'], needsPlayer: false,
  run(a) {
    const names = commandNames();
    if (a[0] && !/^\d+$/.test(a[0])) {
      const e = lookupCommand(a[0]);
      if (!e) return err(`No help for "${a[0]}".${suggestText(closestNames(normalizeName(a[0]), names, 3, 4))}`);
      say(`§e/${e.name}${e.args ? ' ' + e.args : ''}`);
      info(e.desc);
      if (e.aliases.length) info('Aliases: ' + e.aliases.map((x) => '/' + x).join(', '));
      return true;
    }
    const perPage = 8;
    const pages = Math.max(1, Math.ceil(names.length / perPage));
    const page = clamp(int(a[0], 1), 1, pages);
    say(`§e--- Commands (page ${page}/${pages}) ---`);
    for (const n of names.slice((page - 1) * perPage, page * perPage)) {
      const e = COMMANDS['/' + n];
      say(`§6/${n}${e.args ? ' ' + e.args : ''} §7- ${e.desc}`);
    }
    info(`Type §f/help <page>§7 or §f/help <command>§7 for details.`);
    return true;
  },
});

// ---- /give ----------------------------------------------------------------
cmd('give', {
  args: '<item> [count]', desc: 'Puts an item in your inventory.',
  aliases: ['i'], types: ['item'],
  run(a, p) {
    if (!a.length) return usage('give');
    const names = itemNames();
    if (!names.length) return err('The item registry is not available.');
    const r = resolveName(names, a[0]);
    if (!r.name) return err(`Unknown item "${a[0]}".${suggestText(r.matches)}`);
    let count = a[1] === undefined ? 1 : int(a[1], NaN);
    if (!Number.isFinite(count)) return err(`"${a[1]}" is not a number.`);
    if (count < 1) return err('Count must be at least 1.');
    count = Math.min(count, 6400);

    const s = mkStack(r.name, count);
    if (!s) return err(`Could not create "${r.name}".`);
    let left = null;
    try { left = p.giveItem(s); } catch (e) { return err('Could not give the item: ' + e.message); }
    let dropped = 0;
    if (left && left.count > 0) {
      dropped = left.count;
      try { p.dropItem(left, false); } catch { /* the ground is optional */ }
    }
    const given = count - dropped;
    ok(`Gave §e${given}§f × §e${itemDisplay(r.name)}§f to ${p.name || 'you'}`);
    if (dropped) info(`${dropped} did not fit and fell at your feet.`);
    return true;
  },
});

// ---- /tp ------------------------------------------------------------------
cmd('tp', {
  args: '<x y z> | <mob|player|spawn|dimension>', desc: 'Teleports you.',
  aliases: ['teleport'], types: ['target'],
  complete(i) { return i === 1 ? mobNames().concat(playerNames(), ['spawn'], DIMENSION_NAMES) : []; },
  run(a, p) {
    const world = p.world || Game.world;
    if (!a.length) return usage('tp');

    // /tp <dimension>
    const dim = normalizeName(a[0]);
    if (a.length === 1 && DIMENSION_NAMES.indexOf(dim) >= 0) {
      if (dim === (Game.dimension || DIM_OVERWORLD)) return err(`You are already in the ${prettyName(dim)}.`);
      const target = Game.worlds && Game.worlds[dim];
      if (!target) return err(`The ${prettyName(dim)} is not loaded.`);
      const scale = dim === DIM_NETHER ? 1 / 8 : (Game.dimension === DIM_NETHER ? 8 : 1);
      const nx = Math.floor(p.x * scale) + 0.5;
      const nz = Math.floor(p.z * scale) + 0.5;
      let ny = clamp(p.y, 1, WORLD_HEIGHT - 3);
      try {
        target.ensureChunk(Math.floor(nx) >> 4, Math.floor(nz) >> 4);
        ny = clamp(target.getHeight(Math.floor(nx), Math.floor(nz)) + 1, 1, WORLD_HEIGHT - 3);
      } catch { /* keep the old height */ }
      p.teleport(nx, ny, nz, dim);
      return ok(`Teleported to the §e${prettyName(dim)}§f at ${fmtPos(nx, ny, nz)}`);
    }

    let x, y, z, what = '';
    if (a.length >= 3) {
      const pos = parsePos(a, 0, p);
      if (!pos) return err('Bad coordinates. Use numbers, ~relative or ^local.');
      x = pos.x; y = pos.y; z = pos.z;
    } else {
      if (dim === 'spawn') {
        const sp = (world && world.spawnPoint) || { x: 0, y: SEA_LEVEL + 1, z: 0 };
        x = sp.x; y = sp.y; z = sp.z; what = ' (world spawn)';
      } else if (dim === 'bed' || dim === 'home') {
        const rp = p.respawnPoint;
        if (!rp) return err('You have no respawn point set.');
        x = rp.x; y = rp.y; z = rp.z; what = ' (your spawn point)';
      } else {
        const e = nearestOfType(world, p, a[0]);
        if (!e) {
          const all = mobNames().concat(playerNames());
          const r = resolveName(all, a[0]);
          if (r.name) return err(`No ${prettyName(r.name)} is loaded nearby.`);
          return err(`Unknown target "${a[0]}".${suggestText(r.matches)}`);
        }
        x = e.x; y = e.y; z = e.z; what = ` (${prettyName(e.type)})`;
      }
    }

    if (!Number.isFinite(y) || y < 0 || y >= WORLD_HEIGHT) {
      return err(`Y must be between 0 and ${WORLD_HEIGHT - 1}.`);
    }
    // Make sure there is a floor to arrive on.
    try { if (world) world.ensureChunk(Math.floor(x) >> 4, Math.floor(z) >> 4); } catch { /* streaming */ }
    p.teleport(x, y, z);
    return ok(`Teleported to ${fmtPos(x, y, z)}${what}`);
  },
});

// ---- /time ----------------------------------------------------------------
const TIME_PRESETS = Object.assign(Object.create(null), {
  day: TIME_DAY, noon: TIME_NOON, sunset: TIME_SUNSET, night: TIME_NIGHT,
  midnight: TIME_MIDNIGHT, sunrise: TIME_SUNRISE,
});
cmd('time', {
  args: 'set <day|night|noon|midnight|ticks> | add <n> | query',
  desc: 'Reads or changes the world time.',
  types: ['timeop', 'timeval'], needsPlayer: false,
  complete(i, args) {
    if (i === 1) return ['set', 'add', 'query'];
    if (i === 2 && args[0] === 'set') return Object.keys(TIME_PRESETS);
    if (i === 2 && args[0] === 'query') return ['daytime', 'gametime', 'day'];
    return [];
  },
  run(a) {
    const w = Game.world;
    if (!w) return err('No world is loaded.');
    const op = (a[0] || 'query').toLowerCase();

    if (op === 'query') {
      const what = (a[1] || 'daytime').toLowerCase();
      if (what === 'gametime') return ok(`Game time: §e${Math.floor(w.totalTime || 0)}§f ticks`);
      if (what === 'day') return ok(`Day §e${Math.floor((w.totalTime || 0) / 24000)}`);
      return ok(`Time is §e${Math.floor(w.time)}§f (${formatTime(w.time)}, ${w.isDay() ? 'day' : 'night'})`);
    }

    if (op === 'set') {
      if (a[1] === undefined) return usage('time');
      const key = normalizeName(a[1]);
      let t = TIME_PRESETS[key];
      if (t === undefined) {
        t = int(a[1], NaN);
        if (!Number.isFinite(t)) {
          return err(`Unknown time "${a[1]}". Try ${Object.keys(TIME_PRESETS).join(', ')} or a tick count.`);
        }
      }
      w.setTime(t);
      return ok(`Time set to §e${Math.floor(w.time)}§f (${formatTime(w.time)})`);
    }

    if (op === 'add') {
      const n = int(a[1], NaN);
      if (!Number.isFinite(n)) return err(`"${a[1] === undefined ? '' : a[1]}" is not a tick count.`);
      w.setTime(w.time + n);
      return ok(`Added §e${n}§f ticks. Time is now ${Math.floor(w.time)} (${formatTime(w.time)})`);
    }
    return usage('time');
  },
});

// ---- /weather -------------------------------------------------------------
cmd('weather', {
  args: '<clear|rain|thunder> [seconds]', desc: 'Changes the weather.',
  types: ['weather'], needsPlayer: false,
  run(a) {
    const w = Game.world;
    if (!w) return err('No world is loaded.');
    const kind = normalizeName(a[0]);
    if (!kind) return usage('weather');
    const seconds = a[1] === undefined ? 300 : int(a[1], NaN);
    if (!Number.isFinite(seconds) || seconds <= 0) return err('Duration must be a positive number of seconds.');
    const ticks = clamp(seconds * TICKS_PER_SECOND, 1, 1000000);

    if (kind === 'clear' || kind === 'sun' || kind === 'clean') {
      w.setRaining(false, ticks);
      w.setThundering(false, ticks);
      return ok(`Weather set to §eclear§f for ${seconds}s`);
    }
    if (kind === 'rain' || kind === 'snow') {
      w.setRaining(true, ticks);
      w.setThundering(false, ticks);
      return ok(`Weather set to §erain§f for ${seconds}s`);
    }
    if (kind === 'thunder' || kind === 'storm') {
      w.setThundering(true, ticks);
      return ok(`Weather set to §ethunder§f for ${seconds}s`);
    }
    return err(`Unknown weather "${a[0]}". Use clear, rain or thunder.`);
  },
});

// ---- /gamemode ------------------------------------------------------------
const GAMEMODE_ALIASES = Object.assign(Object.create(null), {
  0: GAMEMODE.SURVIVAL, s: GAMEMODE.SURVIVAL, survival: GAMEMODE.SURVIVAL,
  1: GAMEMODE.CREATIVE, c: GAMEMODE.CREATIVE, creative: GAMEMODE.CREATIVE,
  2: GAMEMODE.ADVENTURE, a: GAMEMODE.ADVENTURE, adventure: GAMEMODE.ADVENTURE,
  3: GAMEMODE.SPECTATOR, sp: GAMEMODE.SPECTATOR, spectator: GAMEMODE.SPECTATOR,
});
cmd('gamemode', {
  args: '<survival|creative|adventure|spectator>', desc: 'Switches your game mode.',
  aliases: ['gm'], types: ['gamemode'],
  run(a, p) {
    if (!a.length) return err(`You are in §e${prettyName(p.gameMode)}§f mode. Usage: /gamemode <mode>`);
    const key = normalizeName(a[0]);
    const mode = GAMEMODE_ALIASES[key];
    if (!mode) return err(`Unknown game mode "${a[0]}". Use survival, creative, adventure or spectator (or 0-3).`);
    if (typeof p.setGameMode === 'function') p.setGameMode(mode);
    else { p.gameMode = mode; Game.mode = mode; }
    Game.mode = mode;
    return ok(`Game mode set to §e${prettyName(mode)}`);
  },
});

// ---- /difficulty ----------------------------------------------------------
const DIFFICULTY_ALIASES = Object.assign(Object.create(null), {
  0: DIFFICULTY.PEACEFUL, p: DIFFICULTY.PEACEFUL, peaceful: DIFFICULTY.PEACEFUL,
  1: DIFFICULTY.EASY, e: DIFFICULTY.EASY, easy: DIFFICULTY.EASY,
  2: DIFFICULTY.NORMAL, n: DIFFICULTY.NORMAL, normal: DIFFICULTY.NORMAL,
  3: DIFFICULTY.HARD, h: DIFFICULTY.HARD, hard: DIFFICULTY.HARD,
});
cmd('difficulty', {
  args: '<peaceful|easy|normal|hard>', desc: 'Sets the difficulty.',
  types: ['difficulty'], needsPlayer: false,
  run(a) {
    if (!a.length) return err(`Difficulty is §e${DIFFICULTY_NAMES[Game.difficulty] || 'normal'}§f. Usage: /difficulty <level>`);
    const key = normalizeName(a[0]);
    const d = DIFFICULTY_ALIASES[key];
    if (d === undefined) return err(`Unknown difficulty "${a[0]}". Use peaceful, easy, normal or hard (or 0-3).`);
    Game.difficulty = d;
    try { Game.settings && Game.settings.set('difficulty', d); } catch { /* optional */ }
    return ok(`Difficulty set to §e${DIFFICULTY_NAMES[d]}`);
  },
});

// ---- /summon --------------------------------------------------------------
cmd('summon', {
  args: '<mob> [x y z] [count]', desc: 'Spawns a mob.',
  types: ['mob'],
  run(a, p) {
    if (!a.length) return usage('summon');
    const names = mobNames();
    if (!names.length) return err('The mob registry is not available.');
    const r = resolveName(names, a[0]);
    if (!r.name) return err(`Unknown mob "${a[0]}".${suggestText(r.matches)}`);
    const world = p.world || Game.world;
    if (!world) return err('No world is loaded.');

    let pos = null;
    let countTok = a[1];
    if (a.length >= 4) { pos = parsePos(a, 1, p); countTok = a[4]; }
    if (a.length >= 4 && !pos) return err('Bad coordinates. Use numbers, ~relative or ^local.');
    if (!pos) {
      // Two blocks in front of the player, so it does not land inside them.
      const yaw = p.yaw || 0;
      pos = { x: p.x - Math.sin(yaw) * 2, y: p.y, z: p.z + Math.cos(yaw) * 2 };
    }
    let count = countTok === undefined ? 1 : int(countTok, NaN);
    if (!Number.isFinite(count) || count < 1) count = 1;
    count = Math.min(count, 64);

    const create = M.mobs && (M.mobs.createMob || M.mobs.spawnMob);
    if (typeof create !== 'function') return err('Mob spawning is unavailable.');
    let made = 0;
    for (let i = 0; i < count; i++) {
      const jx = count > 1 ? (Math.random() - 0.5) * 2 : 0;
      const jz = count > 1 ? (Math.random() - 0.5) * 2 : 0;
      const m = create(r.name, world, pos.x + jx, pos.y, pos.z + jz, {});
      if (m) made++;
    }
    if (!made) return err(`Could not summon ${prettyName(r.name)}.`);
    return ok(`Summoned §e${made}§f × §e${prettyName(r.name)}§f at ${fmtPos(pos.x, pos.y, pos.z)}`);
  },
});

// ---- /kill ----------------------------------------------------------------
cmd('kill', {
  args: '[target]', desc: 'Kills you, a mob type or everything.',
  types: ['target'],
  run(a, p) {
    const world = p.world || Game.world;
    const token = a[0];
    const targets = selectEntities(token, p, world);
    if (!targets.length) {
      if (token === undefined) return err('Nothing to kill.');
      const r = resolveName(mobNames(), token);
      if (r.name) return err(`No ${prettyName(r.name)} is loaded.`);
      return err(`Unknown target "${token}".${suggestText(r.matches)}`);
    }
    let n = 0;
    for (const e of targets) {
      try {
        if (typeof e.kill === 'function') e.kill(null);
        else { e.health = 0; e.dead = true; if (typeof e.remove === 'function') e.remove(); }
        n++;
      } catch { /* one bad entity must not stop the rest */ }
    }
    if (targets.length === 1 && targets[0] === p) return ok('Ouch. That looked like it hurt.');
    return ok(`Killed §e${n}§f entit${n === 1 ? 'y' : 'ies'}`);
  },
});

// ---- /setblock ------------------------------------------------------------
cmd('setblock', {
  args: '<x y z> <block> [meta|keep|destroy]', desc: 'Places one block.',
  types: [null, null, null, 'block'],
  complete(i) { return i === 4 ? blockNames() : (i === 5 ? ['keep', 'destroy', 'replace'] : []); },
  run(a, p) {
    if (a.length < 4) return usage('setblock');
    const world = p.world || Game.world;
    if (!world) return err('No world is loaded.');
    const pos = parsePos(a, 0, p);
    if (!pos) return err('Bad coordinates. Use numbers, ~relative or ^local.');
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    if (y < 0 || y >= WORLD_HEIGHT) return err(`Y must be between 0 and ${WORLD_HEIGHT - 1}.`);

    const names = blockNames();
    const r = resolveName(names, a[3]);
    if (!r.name) return err(`Unknown block "${a[3]}".${suggestText(r.matches)}`);
    const def = M.blocks && M.blocks.blockByName ? M.blocks.blockByName(r.name) : null;
    if (!def) return err(`Unknown block "${a[3]}".`);

    let meta = 0;
    let mode = 'replace';
    if (a[4] !== undefined) {
      const m = normalizeName(a[4]);
      if (m === 'keep' || m === 'destroy' || m === 'replace') mode = m;
      else {
        meta = int(a[4], NaN);
        if (!Number.isFinite(meta) || meta < 0 || meta > 15) return err('Metadata must be 0-15.');
      }
    }
    if (a[5] !== undefined) {
      const m = normalizeName(a[5]);
      if (m === 'keep' || m === 'destroy' || m === 'replace') mode = m;
    }

    if (mode === 'keep' && world.getBlock(x, y, z) !== 0) return err('There is already a block there.');
    const changed = world.setBlock(x, y, z, def.id, meta, 3);
    if (!changed) return err('Nothing changed (that block is already there, or the chunk is not loaded).');
    return ok(`Set ${fmtPos(x, y, z)} to §e${blockDisplay(r.name)}${meta ? ' §7[meta ' + meta + ']' : ''}`);
  },
});

/**
 * Bulk block write. Skips per-block lighting and neighbour updates, then
 * relights and re-meshes every touched chunk once at the end.
 * @returns {number} blocks actually changed
 */
function bulkFill(world, x0, y0, z0, x1, y1, z1, id, meta, hollowOnly) {
  let changed = 0;
  // bit 4 suppresses the per-block 'blockchange' event; bit 0/1 are left off so
  // 32k lighting passes and fluid cascades do not stall the frame.
  const flags = 4;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (hollowOnly && x > x0 && x < x1 && y > y0 && y < y1 && z > z0 && z < z1) continue;
        if (world.setBlock(x, y, z, id, meta, flags)) changed++;
      }
    }
  }
  // Relight + mark dirty once per chunk.
  for (let cx = x0 >> 4; cx <= (x1 >> 4); cx++) {
    for (let cz = z0 >> 4; cz <= (z1 >> 4); cz++) {
      let chunk = null;
      try { chunk = world.getChunk(cx, cz); } catch { chunk = null; }
      if (!chunk) continue;
      try {
        if (typeof chunk.recomputeHeightmap === 'function') chunk.recomputeHeightmap();
        if (M.lighting && typeof M.lighting.initSkyLight === 'function') M.lighting.initSkyLight(world, chunk);
      } catch { /* lighting is best effort */ }
      chunk.dirty = true;
      try { world.markDirty((cx << 4) + 8, clamp(y1, 0, WORLD_HEIGHT - 1), (cz << 4) + 8); } catch { /* optional */ }
      try { Game.chunkRenderer && Game.chunkRenderer.setChunkDirty(cx, cz); } catch { /* optional */ }
      // Borders share vertices with the neighbours, so nudge them too.
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        try { Game.chunkRenderer && Game.chunkRenderer.setChunkDirty(cx + dx, cz + dz); } catch { /* optional */ }
      }
    }
  }
  return changed;
}

// ---- /fill ----------------------------------------------------------------
cmd('fill', {
  args: '<x1 y1 z1> <x2 y2 z2> <block> [meta|hollow]', desc: 'Fills a box with a block.',
  types: [null, null, null, null, null, null, 'block'],
  complete(i) { return i === 7 ? blockNames() : (i === 8 ? ['hollow', 'confirm'] : []); },
  run(a, p) {
    const chat = ACTIVE;
    const world = p.world || Game.world;
    if (!world) return err('No world is loaded.');

    const first = a[0] === undefined ? '' : normalizeName(a[0]);
    if (first === 'confirm') {
      const pend = chat && chat._pendingFill;
      if (!pend) return err('Nothing to confirm.');
      chat._pendingFill = null;
      const n = bulkFill(world, pend.x0, pend.y0, pend.z0, pend.x1, pend.y1, pend.z1, pend.id, pend.meta, pend.hollow);
      return ok(`Filled §e${n}§f block${n === 1 ? '' : 's'} with §e${blockDisplay(pend.blockName)}`);
    }
    if (first === 'cancel') {
      if (chat) chat._pendingFill = null;
      return info('Fill cancelled.');
    }
    if (a.length < 7) return usage('fill');

    const p1 = parsePos(a, 0, p);
    const p2 = parsePos(a, 3, p);
    if (!p1 || !p2) return err('Bad coordinates. Use numbers, ~relative or ^local.');
    const x0 = Math.min(Math.floor(p1.x), Math.floor(p2.x)), x1 = Math.max(Math.floor(p1.x), Math.floor(p2.x));
    const y0 = Math.min(Math.floor(p1.y), Math.floor(p2.y)), y1 = Math.max(Math.floor(p1.y), Math.floor(p2.y));
    const z0 = Math.min(Math.floor(p1.z), Math.floor(p2.z)), z1 = Math.max(Math.floor(p1.z), Math.floor(p2.z));
    if (y0 < 0 || y1 >= WORLD_HEIGHT) return err(`Y must stay between 0 and ${WORLD_HEIGHT - 1}.`);

    const r = resolveName(blockNames(), a[6]);
    if (!r.name) return err(`Unknown block "${a[6]}".${suggestText(r.matches)}`);
    const def = M.blocks && M.blocks.blockByName ? M.blocks.blockByName(r.name) : null;
    if (!def) return err(`Unknown block "${a[6]}".`);

    let meta = 0;
    let hollow = false;
    for (let i = 7; i < a.length; i++) {
      const t = normalizeName(a[i]);
      if (t === 'hollow' || t === 'outline') hollow = true;
      else {
        const mv = int(a[i], NaN);
        if (Number.isFinite(mv) && mv >= 0 && mv <= 15) meta = mv;
      }
    }

    const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (volume > MAX_FILL) {
      return err(`That is ${volume.toLocaleString()} blocks; the limit is ${MAX_FILL.toLocaleString()}.`);
    }
    if (volume > CONFIRM_FILL) {
      if (chat) {
        chat._pendingFill = { x0, y0, z0, x1, y1, z1, id: def.id, meta, hollow, blockName: r.name };
      }
      warn(`That will change ${volume.toLocaleString()} blocks. Type §f/fill confirm§e to go ahead, or §f/fill cancel§e.`);
      return false;
    }
    const n = bulkFill(world, x0, y0, z0, x1, y1, z1, def.id, meta, hollow);
    if (!n) return err('Nothing changed (those chunks may not be loaded).');
    return ok(`Filled §e${n}§f block${n === 1 ? '' : 's'} with §e${blockDisplay(r.name)}`);
  },
});

// ---- /seed ----------------------------------------------------------------
cmd('seed', {
  args: '', desc: 'Shows the world seed.', needsPlayer: false,
  run() {
    const w = Game.world;
    const seed = (w && w.seed !== undefined ? w.seed : Game.seed) >>> 0;
    ok(`Seed: §e${seed}`);
    if (w) info(`Dimension: ${prettyName(w.dimension || DIM_OVERWORLD)} · World: ${Game.worldName}`);
    return true;
  },
});

// ---- /effect --------------------------------------------------------------
cmd('effect', {
  args: '<effect|clear> [seconds] [level]', desc: 'Gives you a status effect.',
  types: ['effect'],
  run(a, p) {
    const mod = M.effects;
    if (!mod) return err('The effect registry is not available.');
    if (!a.length) return usage('effect');
    const first = normalizeName(a[0]);

    if (first === 'clear') {
      if (a[1]) {
        const r = resolveName(effectNames(), a[1]);
        if (!r.name) return err(`Unknown effect "${a[1]}".${suggestText(r.matches)}`);
        const had = mod.removeEffect ? mod.removeEffect(p, r.name) : false;
        return had ? ok(`Removed §e${prettyName(r.name)}`) : err(`You do not have ${prettyName(r.name)}.`);
      }
      const n = mod.clearEffects ? mod.clearEffects(p, false) : 0;
      return ok(`Cleared §e${n}§f effect${n === 1 ? '' : 's'}`);
    }

    const r = resolveName(effectNames(), a[0]);
    if (!r.name) return err(`Unknown effect "${a[0]}".${suggestText(r.matches)}`);
    let seconds = a[1] === undefined ? 30 : int(a[1], NaN);
    if (!Number.isFinite(seconds) || seconds < 0) return err('Duration must be a number of seconds.');
    seconds = Math.min(seconds, 1000000);
    let level = a[2] === undefined ? 1 : int(a[2], NaN);
    if (!Number.isFinite(level) || level < 1) return err('Level must be 1 or more.');
    level = Math.min(level, 255);

    const applied = mod.addEffect ? mod.addEffect(p, r.name, seconds * TICKS_PER_SECOND, level - 1) : false;
    if (!applied) return err(`${prettyName(r.name)} could not be applied (a stronger one may already be active).`);
    return ok(`Applied §e${prettyName(r.name)} ${level}§f for ${seconds}s`);
  },
});

// ---- /enchant -------------------------------------------------------------
cmd('enchant', {
  args: '<enchantment> [level] [force]', desc: 'Enchants the held item.',
  types: ['enchant'],
  run(a, p) {
    const mod = M.enchanting;
    if (!mod) return err('The enchantment registry is not available.');
    if (!a.length) return usage('enchant');
    const held = typeof p.getHeldItem === 'function' ? p.getHeldItem() : null;
    if (!held || !held.item) return err('You are not holding anything.');

    const r = resolveName(enchantNames(), a[0]);
    if (!r.name) return err(`Unknown enchantment "${a[0]}".${suggestText(r.matches)}`);
    const def = mod.ENCHANTMENTS ? mod.ENCHANTMENTS[r.name] : null;
    const maxLevel = (def && def.maxLevel) || 5;

    let level = a[1] === undefined ? maxLevel : int(a[1], NaN);
    if (!Number.isFinite(level) || level < 1) return err('Level must be 1 or more.');
    const force = a.indexOf('force') >= 0 || a.indexOf('-f') >= 0;
    if (level > maxLevel && !force) {
      info(`${prettyName(r.name)} caps at level ${maxLevel}; add "force" to go higher.`);
      level = maxLevel;
    }

    if (!force && typeof mod.canApply === 'function' && !mod.canApply(r.name, held.item)) {
      return err(`${prettyName(r.name)} cannot go on a ${itemDisplay(held.item)}. Add "force" to do it anyway.`);
    }
    if (typeof mod.applyEnchant !== 'function') return err('Enchanting is unavailable.');
    mod.applyEnchant(held, r.name, level, force);
    try { p.inventory && p.inventory.markChanged(p.inventory.selected); } catch { /* optional */ }
    return ok(`Enchanted §e${itemDisplay(held.item)}§f with §e${prettyName(r.name)} ${level}`);
  },
});

// ---- /xp ------------------------------------------------------------------
cmd('xp', {
  args: '<n>[L]', desc: 'Grants experience points, or levels with an L suffix.',
  aliases: ['experience'],
  run(a, p) {
    if (!a.length) {
      return ok(`Level §e${p.xpLevel}§f, §e${Math.round(p.xpProgress * 100)}%§f to the next (${p.totalXPPoints ? p.totalXPPoints() : p.xp} points)`);
    }
    const tok = String(a[0]);
    const levels = /[lL]$/.test(tok);
    const n = int(levels ? tok.slice(0, -1) : tok, NaN);
    if (!Number.isFinite(n)) return err(`"${a[0]}" is not a number. Try /xp 100 or /xp 5L.`);

    if (levels) {
      const before = p.xpLevel;
      p.xpLevel = Math.max(0, (p.xpLevel | 0) + n);
      if (n < 0 && p.xpLevel === 0) p.xpProgress = 0;
      // Keep the lifetime counter roughly honest so the HUD bar behaves.
      if (typeof p.totalXPPoints === 'function') p.xp = p.totalXPPoints();
      if (p.xpLevel > before) Game.emit('levelup', p.xpLevel);
      return ok(`${n >= 0 ? 'Gave' : 'Took'} §e${Math.abs(n)}§f level${Math.abs(n) === 1 ? '' : 's'}. You are level §e${p.xpLevel}`);
    }
    p.addXP(n);
    return ok(`${n >= 0 ? 'Gave' : 'Took'} §e${Math.abs(n)}§f experience. You are level §e${p.xpLevel}`);
  },
});

// ---- /heal ----------------------------------------------------------------
cmd('heal', {
  args: '[amount]', desc: 'Restores health, hunger and air.',
  run(a, p) {
    const amount = a[0] === undefined ? Infinity : num(a[0], NaN);
    if (!Number.isFinite(amount) && a[0] !== undefined) return err(`"${a[0]}" is not a number.`);
    const before = p.health;
    if (Number.isFinite(amount)) p.heal(amount);
    else {
      p.health = p.maxHealth;
      p.hunger = MAX_HUNGER;
      p.saturation = 5;
      p.exhaustion = 0;
      p.airSupply = MAX_AIR;
      p.fireTicks = 0;
      p.fallDistance = 0;
    }
    const gained = Math.round((p.health - before) * 10) / 10;
    return ok(Number.isFinite(amount)
      ? `Healed §e${gained}§f health (${Math.round(p.health)}/${p.maxHealth})`
      : `Fully healed and fed (${Math.round(p.health)}/${p.maxHealth})`);
  },
});

// ---- /clear ---------------------------------------------------------------
cmd('clear', {
  args: '[item] [count]', desc: 'Empties your inventory, or removes one item.',
  types: ['item'],
  run(a, p) {
    const inv = p.inventory;
    if (!inv) return err('You have no inventory.');
    if (!a.length) {
      let n = 0;
      for (let i = 0; i < inv.size; i++) {
        const s = inv.get(i);
        if (s) n += s.count | 0;
      }
      inv.clear();
      return ok(`Removed §e${n}§f item${n === 1 ? '' : 's'} from your inventory`);
    }
    const r = resolveName(itemNames(), a[0]);
    if (!r.name) return err(`Unknown item "${a[0]}".${suggestText(r.matches)}`);
    const want = a[1] === undefined ? Infinity : int(a[1], NaN);
    if (!Number.isFinite(want) && a[1] !== undefined) return err(`"${a[1]}" is not a count.`);
    const have = inv.count(r.name);
    if (!have) return err(`You have no ${itemDisplay(r.name)}.`);
    const n = inv.removeItem(r.name, Number.isFinite(want) ? want : have);
    return ok(`Removed §e${n}§f × §e${itemDisplay(r.name)}`);
  },
});

// ---- /spawnpoint ----------------------------------------------------------
cmd('spawnpoint', {
  args: '[x y z]', desc: 'Sets where you respawn.',
  run(a, p) {
    let pos;
    if (a.length >= 3) {
      pos = parsePos(a, 0, p);
      if (!pos) return err('Bad coordinates. Use numbers, ~relative or ^local.');
    } else {
      pos = { x: p.x, y: p.y, z: p.z };
    }
    const x = Math.floor(pos.x) + 0.5, y = Math.floor(pos.y), z = Math.floor(pos.z) + 0.5;
    if (y < 0 || y >= WORLD_HEIGHT) return err(`Y must be between 0 and ${WORLD_HEIGHT - 1}.`);
    if (typeof p.setRespawnPoint === 'function') p.setRespawnPoint(x, y, z);
    else p.respawnPoint = { x, y, z };
    const w = p.world || Game.world;
    if (w) w.spawnPoint = { x, y, z };
    return ok(`Spawn point set to ${fmtPos(x, y, z)}`);
  },
});

// ---- /gamerule ------------------------------------------------------------
cmd('gamerule', {
  args: '<rule> [value]', desc: 'Reads or sets a game rule.',
  types: ['gamerule', 'bool'], needsPlayer: false,
  run(a) {
    const w = Game.world;
    if (!w) return err('No world is loaded.');
    const rules = w.gameRules || (w.gameRules = {});
    const names = gameRuleNames();
    if (!a.length) {
      say('§e--- Game rules ---');
      for (const n of names) {
        const v = n === 'randomTickSpeed' ? w.randomTickSpeed : rules[n];
        say(`§6${n}§7 = §f${v}`);
      }
      return true;
    }
    const r = resolveName(names.map((n) => n.toLowerCase()), a[0]);
    const key = r.name ? names.find((n) => n.toLowerCase() === r.name) : null;
    if (!key) return err(`Unknown game rule "${a[0]}".${suggestText(r.matches)}`);

    const readValue = () => (key === 'randomTickSpeed' ? w.randomTickSpeed : rules[key]);
    if (a[1] === undefined) return ok(`§6${key}§f = §e${readValue()}`);

    const raw = String(a[1]).toLowerCase();
    let value;
    if (raw === 'true' || raw === 'on' || raw === 'yes' || raw === '1') value = true;
    else if (raw === 'false' || raw === 'off' || raw === 'no' || raw === '0') value = false;
    else {
      const n = num(raw, NaN);
      if (!Number.isFinite(n)) return err(`"${a[1]}" is not true, false or a number.`);
      value = n;
    }
    if (key === 'randomTickSpeed') {
      w.randomTickSpeed = clamp(typeof value === 'number' ? value : (value ? 3 : 0), 0, 64);
      return ok(`§6randomTickSpeed§f set to §e${w.randomTickSpeed}`);
    }
    if (typeof readValue() === 'boolean' && typeof value === 'number') value = value !== 0;
    rules[key] = value;
    return ok(`§6${key}§f set to §e${value}`);
  },
});

// ---- /locate --------------------------------------------------------------
cmd('locate', {
  args: '<structure>', desc: 'Finds the nearest structure.',
  types: ['structure'],
  run(a, p) {
    const mod = M.structures;
    if (!mod || typeof mod.nearestStructure !== 'function') return err('Structure lookup is unavailable.');
    const names = structureNames();
    if (!a.length) {
      info('Structures: ' + (names.length ? names.join(', ') : 'none registered'));
      return usage('locate');
    }
    const r = resolveName(names, a[0]);
    if (!r.name) return err(`Unknown structure "${a[0]}".${suggestText(r.matches)}`);
    const world = p.world || Game.world;
    let hit = null;
    try { hit = mod.nearestStructure(world, r.name, p.x, p.z, 6400); } catch (e) { return err('Search failed: ' + e.message); }
    if (!hit) return err(`No ${prettyName(r.name)} within 6400 blocks (it may not generate in this dimension).`);
    ok(`Nearest §e${prettyName(r.name)}§f is at ${fmtPos(hit.x, hit.y, hit.z)}`);
    info(`${Math.round(hit.distance)} blocks away. Click the coordinates to teleport.`);
    return true;
  },
});

// ---- /fly -----------------------------------------------------------------
cmd('fly', {
  args: '[on|off]', desc: 'Toggles flight.', types: ['toggle'],
  run(a, p) {
    const cur = !!p.canFly;
    const t = a[0] === undefined ? !cur : /^(on|true|1|yes|enable)$/i.test(a[0]);
    p.canFly = t;
    p.flying = t ? p.flying : false;
    if (t && !p.onGround) p.flying = true;
    return ok(`Flight §e${t ? 'enabled' : 'disabled'}${t ? '§f. Double-tap jump to take off.' : ''}`);
  },
});

// ---- /speed ---------------------------------------------------------------
cmd('speed', {
  args: '<multiplier>', desc: 'Sets your movement speed multiplier.',
  run(a, p) {
    if (!a.length) return ok(`Speed multiplier is §e${fmt(p.flySpeedMul || 1)}×`);
    const n = num(a[0], NaN);
    if (!Number.isFinite(n) || n <= 0) return err('Speed must be a positive number, e.g. /speed 2.');
    const v = clamp(n, 0.1, 20);
    p.flySpeedMul = v;
    // On foot the movement code reads status effects, so mirror the multiplier
    // there: +20% per speed level, -15% per slowness level.
    const fx = M.effects;
    if (fx && typeof fx.addEffect === 'function') {
      try {
        if (typeof fx.removeEffect === 'function') { fx.removeEffect(p, 'speed'); fx.removeEffect(p, 'slowness'); }
        if (v > 1.02) {
          const lvl = clamp(Math.round((v - 1) / 0.2), 1, 20);
          fx.addEffect(p, 'speed', 1000000, lvl - 1, { showParticles: false });
        } else if (v < 0.98) {
          const lvl = clamp(Math.round((1 - v) / 0.15), 1, 6);
          fx.addEffect(p, 'slowness', 1000000, lvl - 1, { showParticles: false });
        }
      } catch { /* effects are optional */ }
    }
    return ok(`Speed set to §e${fmt(v)}×§f (walking and flying)`);
  },
});

// ---- /noclip --------------------------------------------------------------
cmd('noclip', {
  args: '[on|off]', desc: 'Walk through blocks.', types: ['toggle'],
  run(a, p) {
    const chat = ACTIVE;
    const cur = chat ? !!chat._noclip : !!p.noClip;
    const t = a[0] === undefined ? !cur : /^(on|true|1|yes|enable)$/i.test(a[0]);
    if (chat) chat._noclip = t;
    // player.applyMovementInput rewrites noClip every frame, so hold it with an
    // accessor rather than a value the next tick would clobber.
    try {
      if (t) Object.defineProperty(p, 'noClip', { configurable: true, get: () => true, set: () => {} });
      else { delete p.noClip; p.noClip = false; }
    } catch { p.noClip = t; }
    if (t) { p.canFly = true; p.flying = true; }
    return ok(`Noclip §e${t ? 'enabled' : 'disabled'}`);
  },
});

// ---- /save ----------------------------------------------------------------
cmd('save', {
  args: '', desc: 'Writes the world to storage.', needsPlayer: false,
  run() {
    const save = Game.save;
    if (!save || typeof save.saveWorld !== 'function') return err('Saving is unavailable.');
    info('Saving world…');
    try {
      const p = save.saveWorld(Game, Game.worldName);
      if (p && typeof p.then === 'function') {
        p.then(() => say(`Saved §e${Game.worldName}`))
          .catch((e) => say('Save failed: ' + (e && e.message ? e.message : e), 'error'));
      } else {
        ok(`Saved §e${Game.worldName}`);
      }
    } catch (e) {
      return err('Save failed: ' + e.message);
    }
    return true;
  },
});

// ---- /tps -----------------------------------------------------------------
cmd('tps', {
  args: '', desc: 'Shows performance counters.', needsPlayer: false,
  run() {
    const s = Game.stats || {};
    const tps = ACTIVE ? ACTIVE._tps : 20;
    const tpsColor = tps >= 19 ? '§a' : tps >= 15 ? '§e' : '§c';
    say(`TPS ${tpsColor}${fmt(Math.min(tps, 20))}§f/20 · FPS §e${s.fps || 0}§f · frame §e${fmt(s.frameMs || 0)}§f ms · tick §e${fmt(s.tickMs || 0)}§f ms`);
    info(`Chunks ${s.chunksLoaded || 0} loaded, ${s.chunksRendered || 0} drawn, ${s.chunksQueued || 0} queued · entities ${s.entities || 0}`);
    info(`Draw calls ${s.drawCalls || 0} · triangles ${(s.triangles || 0).toLocaleString()} · mesh ${fmt(s.meshMs || 0)} ms · gen ${fmt(s.genMs || 0)} ms`);
    return true;
  },
});

// ---- /gc ------------------------------------------------------------------
cmd('gc', {
  args: '', desc: 'Drops cached meshes, icons and far chunks.', needsPlayer: false,
  run() {
    let unloaded = 0;
    const rd = (() => {
      try { return Game.settings ? (Game.settings.get('renderDistance') || 8) : 8; } catch { return 8; }
    })();
    for (const key of Object.keys(Game.worlds || {})) {
      const w = Game.worlds[key];
      if (!w || typeof w.pruneChunks !== 'function') continue;
      try { unloaded += w.pruneChunks(w === Game.world ? rd + 2 : 1, 4096); } catch { /* optional */ }
    }
    try { Game.particles && Game.particles.clear(); } catch { /* optional */ }
    try { M.itemrender && M.itemrender.invalidateIconCache && M.itemrender.invalidateIconCache(); } catch { /* optional */ }
    try { M.models && M.models.disposeModelCache && M.models.disposeModelCache(); } catch { /* optional */ }
    try { Game.entityRenderer && Game.entityRenderer.clear(); } catch { /* optional */ }
    try { Game.renderer && Game.renderer.renderLists && Game.renderer.renderLists.dispose(); } catch { /* optional */ }
    if (typeof globalThis.gc === 'function') { try { globalThis.gc(); } catch { /* not exposed */ } }

    ok(`Released §e${unloaded}§f chunk${unloaded === 1 ? '' : 's'} and emptied the icon, model and particle caches.`);
    const mem = typeof performance !== 'undefined' && performance.memory;
    if (mem && mem.usedJSHeapSize) {
      info(`Heap: ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB of ${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB`);
    }
    return true;
  },
});

// ---- /particle ------------------------------------------------------------
cmd('particle', {
  args: '<name> [x y z] [count]', desc: 'Spawns particles.',
  types: ['particle'],
  run(a, p) {
    const P = Game.particles;
    if (!P || typeof P.spawn !== 'function') return err('The particle system is unavailable.');
    if (!a.length) return usage('particle');
    const r = resolveName(PARTICLE_NAMES, a[0]);
    if (!r.name) return err(`Unknown particle "${a[0]}".${suggestText(r.matches)}`);

    let pos = null;
    let countTok = a[1];
    if (a.length >= 4) { pos = parsePos(a, 1, p); countTok = a[4]; }
    if (a.length >= 4 && !pos) return err('Bad coordinates. Use numbers, ~relative or ^local.');
    if (!pos) pos = { x: p.x, y: p.y + (p.eyeHeight || 1.62) * 0.5, z: p.z };
    let count = countTok === undefined ? 12 : int(countTok, NaN);
    if (!Number.isFinite(count) || count < 1) count = 12;
    count = Math.min(count, 256);

    const n = P.spawn(r.name, pos.x, pos.y, pos.z, { count, spread: 0.5 });
    return ok(`Spawned §e${n || count}§f × §e${prettyName(r.name)}§f at ${fmtPos(pos.x, pos.y, pos.z)}`);
  },
});

// ---- /playsound -----------------------------------------------------------
cmd('playsound', {
  args: '<sound> [x y z] [volume] [pitch]', desc: 'Plays a sound.',
  types: ['sound'],
  run(a, p) {
    const audio = Game.audio;
    if (!audio || typeof audio.play !== 'function') return err('The sound engine is unavailable.');
    if (!a.length) return usage('playsound');
    const names = soundNames();
    const r = names.length ? resolveName(names, a[0]) : { name: normalizeName(a[0]), matches: [] };
    if (!r.name) return err(`Unknown sound "${a[0]}".${suggestText(r.matches)}`);

    let pos = null;
    let vi = 1;
    if (a.length >= 4) { pos = parsePos(a, 1, p); vi = 4; }
    if (a.length >= 4 && !pos) return err('Bad coordinates. Use numbers, ~relative or ^local.');
    const volume = a[vi] === undefined ? 1 : clamp(num(a[vi], 1), 0, 4);
    const pitch = a[vi + 1] === undefined ? 1 : clamp(num(a[vi + 1], 1), 0.25, 4);

    if (pos) audio.play(r.name, { volume, pitch, x: pos.x, y: pos.y, z: pos.z });
    else audio.play(r.name, { volume, pitch });
    return ok(`Played §e${r.name}§f at volume ${fmt(volume)}, pitch ${fmt(pitch)}`);
  },
});

// ---- /title ---------------------------------------------------------------
cmd('title', {
  args: '<text> | subtitle <text> | actionbar <text> | clear', desc: 'Shows a big on-screen title.',
  types: ['titleop'], needsPlayer: false,
  run(a) {
    const hud = Game.ui && Game.ui.hud;
    if (!hud) return err('The HUD is unavailable.');
    const chat = ACTIVE;
    const op = a.length ? normalizeName(a[0]) : '';

    if (op === 'clear') {
      if (typeof hud.showTitle === 'function') hud.showTitle('', '', 1);
      if (typeof hud.setActionBar === 'function') hud.setActionBar('', 0);
      if (chat) chat._subtitle = '';
      return info('Titles cleared.');
    }
    if (op === 'times') {
      const stay = int(a[2], 60);
      if (chat) chat._titleMs = clamp(stay * 50, 200, 20000);
      return ok(`Title hold set to ${fmt((chat ? chat._titleMs : 3000) / 1000)}s`);
    }
    if (op === 'subtitle') {
      const text = a.slice(1).join(' ');
      if (chat) chat._subtitle = text;
      return info(text ? `Subtitle queued: ${text}` : 'Subtitle cleared.');
    }
    if (op === 'actionbar') {
      const text = a.slice(1).join(' ');
      if (!text) return usage('title');
      if (typeof hud.setActionBar === 'function') hud.setActionBar(text);
      return ok('Action bar set.');
    }
    const text = a.join(' ');
    if (!text) return usage('title');
    const sub = (chat && chat._subtitle) || '';
    const ms = (chat && chat._titleMs) || 3000;
    if (typeof hud.showTitle === 'function') hud.showTitle(text, sub, ms);
    if (chat) chat._subtitle = '';
    return ok('Title shown.');
  },
});

// ---- /say and /me ---------------------------------------------------------
cmd('say', {
  args: '<message>', desc: 'Broadcasts a message.', needsPlayer: false,
  run(a) {
    const text = a.join(' ');
    if (!text) return usage('say');
    say(`§d[Server] §f${text}`);
    return true;
  },
});
cmd('me', {
  args: '<action>', desc: 'Emotes in the third person.',
  run(a, p) {
    const text = a.join(' ');
    if (!text) return usage('me');
    say(`§o* ${(p && p.name) || 'Player'} ${text}`);
    return true;
  },
});

// ---- /clearchat -----------------------------------------------------------
cmd('clearchat', {
  args: '', desc: 'Empties the chat log.', needsPlayer: false,
  run() {
    if (ACTIVE) ACTIVE.clear();
    return true;
  },
});

// ===========================================================================
// The Chat UI
// ===========================================================================

/**
 * The chat log and the command line. One instance, mounted in `#chat-layer`.
 */
export class Chat {
  /** @param {HTMLElement} root the `#chat-layer` element */
  constructor(root) {
    ensureDeps();
    this.root = root || document.createElement('div');
    ACTIVE = this;

    /** @type {Array<{el:HTMLElement, born:number, state:string, text:string}>} */
    this.messages = [];
    /** Sent lines, newest last. */
    this.history = [];
    this.historyIndex = -1;
    this.draft = '';

    this.open = false;
    this.suggestions = [];
    this.suggestIndex = -1;
    this._suggestSig = '';
    this._tokenStart = 0;
    this._tokenEnd = 0;
    /** True while repeated Tab presses are walking the candidate list. */
    this._cycling = false;

    this._now = 0;
    this._opacity = -1;
    this._optTimer = 0;
    this._pendingOpen = null;
    this._guardUntil = 0;
    this._guardValue = '';
    this._wasLocked = false;

    // Command-owned state that has to outlive a single run.
    this._pendingFill = null;
    this._noclip = false;
    this._subtitle = '';
    this._titleMs = 3000;

    // TPS estimate for /tps and the F3 overlay.
    this._tps = 20;
    this._tpsTimer = 0;
    this._tpsBase = Game.ticks || 0;

    this._build();
    this._wire();
    this._applyOpacity();
  }

  /** True while the input line owns the keyboard. */
  get isOpen() { return this.open; }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------
  _build() {
    const root = this.root;
    root.textContent = '';
    root.classList.remove('open');

    this.logEl = el('div', 'chat-log', root);
    this.inputBar = el('div', 'chat-input', root);
    this.inputBar.hidden = true;

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'chat-input-field';
    field.maxLength = 256;
    field.autocomplete = 'off';
    field.autocapitalize = 'off';
    field.spellcheck = false;
    field.setAttribute('aria-label', 'Chat');
    this.inputBar.appendChild(field);
    this.field = field;

    this.suggestEl = el('div', 'chat-suggestions', root);
    this.suggestEl.hidden = true;
  }

  _wire() {
    this.field.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.field.addEventListener('input', () => this._onInput());
    this.field.addEventListener('blur', () => {
      // Losing focus while open would silently swallow every keystroke.
      if (!this.open) return;
      setTimeout(() => {
        if (!this.open) return;
        try { this.field.focus({ preventScroll: true }); } catch { /* the field is gone */ }
      }, 0);
    });

    this._onWheel = (e) => {
      if (!this.open) return;
      const dy = e.deltaY || 0;
      if (!dy) return;
      e.preventDefault();
      e.stopPropagation();
      const step = this._lineHeight() * 3;
      this.logEl.scrollTop += Math.sign(dy) * step;
    };
    this.root.addEventListener('wheel', this._onWheel, { passive: false });

    // A click on the empty layer (not on a line or the field) closes the chat.
    this.root.addEventListener('mousedown', (e) => {
      if (!this.open) return;
      if (e.target === this.root) this.closeInput();
    });

    // Clicking a suggestion must not steal focus from the field.
    this.suggestEl.addEventListener('mousedown', (e) => e.preventDefault());

    try {
      Game.on('worldloaded', () => {
        this.clear();
        this._pendingFill = null;
        this.addMessage('§7Type §f/help§7 for the command list. Press §fT§7 to chat.');
      });
    } catch { /* the event bus is optional */ }
  }

  _lineHeight() {
    const first = this.messages.length ? this.messages[this.messages.length - 1].el : null;
    const h = first ? first.offsetHeight : 0;
    return h > 4 ? h : 16;
  }

  // -------------------------------------------------------------------------
  // Log
  // -------------------------------------------------------------------------
  /**
   * Appends a line to the log. `text` may carry §-codes; `color` may be a
   * colour name, one of system/error/whisper/dim, a hex number or CSS colour.
   * @param {string} text
   * @param {string|number} [color]
   */
  addMessage(text, color) {
    const str = text == null ? '' : String(text);
    const parts = str.split('\n');
    for (let i = 0; i < parts.length; i++) this._push(parts[i], color);
    return this;
  }

  _push(text, color) {
    if (!this.logEl) return;
    const atBottom = this._atBottom();
    const node = el('div', 'chat-line');
    applyColorTo(node, color);
    try { renderRich(node, text, this); } catch { node.textContent = String(text); }
    this.logEl.appendChild(node);

    const rec = { el: node, born: this._now, state: '', text: String(text) };
    this.messages.push(rec);
    while (this.messages.length > MAX_LINES) {
      const old = this.messages.shift();
      if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
    this._refreshVisibility();
    if (this.open && atBottom) this._scrollToBottom();
  }

  /** Empties the log. */
  clear() {
    for (const m of this.messages) {
      if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
    }
    this.messages.length = 0;
    return this;
  }

  _atBottom() {
    const l = this.logEl;
    if (!l) return true;
    return l.scrollHeight - l.clientHeight - l.scrollTop < 12;
  }

  _scrollToBottom() {
    if (this.logEl) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Decides which lines are on screen, and which are fading out. */
  _refreshVisibility() {
    const list = this.messages;
    const n = list.length;
    const open = this.open;
    const now = this._now;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      const fromEnd = n - 1 - i;
      let state;
      if (open) state = 'show';
      else {
        const age = now - m.born;
        if (fromEnd >= VISIBLE_LINES || age > FADE_AFTER + FADE_TIME) state = 'gone';
        else if (age > FADE_AFTER) state = 'fade';
        else state = 'show';
      }
      if (state === m.state) continue;
      m.state = state;
      const node = m.el;
      if (node.hidden !== (state === 'gone')) node.hidden = state === 'gone';
      node.classList.toggle('fading', state === 'fade');
    }
  }

  // -------------------------------------------------------------------------
  // Input line
  // -------------------------------------------------------------------------
  /**
   * Opens the command line.
   * @param {string} [prefix] text to start with, e.g. '/' for a command
   */
  openInput(prefix = '') {
    const pre = typeof prefix === 'string' ? prefix : '';
    this._pendingOpen = null;
    if (this.open) {
      if (pre) this._insertAtCaret(pre);
      return this;
    }
    this.open = true;
    this.root.classList.add('open');
    this.inputBar.hidden = false;
    // The log is bottom-aligned when shut; a flex-end column that overflows
    // cannot always be scrolled back up, so switch to top alignment (and pin
    // the view to the bottom) for as long as the scrollback is in use.
    this.logEl.style.justifyContent = 'flex-start';
    this.field.value = pre;
    this.historyIndex = -1;
    this.draft = pre;
    this._cycling = false;

    // The keystroke that opened us may still be dispatched into the field.
    this._guardUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + OPEN_GUARD_MS;
    this._guardValue = pre;

    this._wasLocked = !!(Game.input && Game.input.pointerLocked);
    this._guardLock();
    try { Game.input && Game.input.exitPointerLock(); } catch { /* optional */ }

    this._refreshVisibility();
    try {
      this.field.focus({ preventScroll: true });
      this.field.setSelectionRange(pre.length, pre.length);
    } catch { /* focus can fail while the tab is hidden */ }
    this._scrollToBottom();
    this._updateSuggestions();
    return this;
  }

  /** Closes the command line without sending anything. */
  closeInput() {
    if (!this.open) return this;
    this.open = false;
    this.root.classList.remove('open');
    this.inputBar.hidden = true;
    this.logEl.style.justifyContent = '';
    this.field.value = '';
    this.historyIndex = -1;
    this._hideSuggestions();
    try { this.field.blur(); } catch { /* optional */ }
    this._refreshVisibility();
    this._relock();
    return this;
  }

  /** Reads the field, sends it, and closes. */
  send() {
    const raw = this.field.value;
    const text = raw.trim();
    this.closeInput();
    if (!text) return false;
    if (this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      while (this.history.length > MAX_HISTORY) this.history.shift();
    }
    if (text[0] === '/') return this.runCommand(text);
    this.addMessage(`<${(Game.player && Game.player.name) || 'Player'}> ${text}`);
    try { Game.emit('chatmessage', text); } catch { /* optional */ }
    return true;
  }

  /**
   * Parses and executes a command line. The leading slash is optional.
   * @param {string} text
   * @returns {boolean} true when a command ran
   */
  runCommand(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return false;
    const body = raw[0] === '/' ? raw.slice(1) : raw;
    const parts = tokenize(body);
    if (!parts.length) return false;
    const name = parts[0].toLowerCase();
    const entry = lookupCommand(name);
    if (!entry) {
      const near = closestNames(normalizeName(name), commandNames(), 3, 4);
      err(`Unknown command "/${parts[0]}".${suggestText(near.map((n) => '/' + n))}`);
      info('Type /help for the full list.');
      return false;
    }
    const player = Game.player;
    if (entry.needsPlayer && !player) return err('That command needs a player in the world.');
    try {
      entry.run(parts.slice(1), player);
    } catch (e) {
      console.error('[chat] /' + entry.name + ' failed', e);
      err(`/${entry.name} failed: ${e && e.message ? e.message : e}`);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  _onKeyDown(e) {
    const key = e.key;
    if (key === 'Enter' || key === 'NumpadEnter') {
      // Enter always sends, even with the suggestion box up. Tab completes.
      e.preventDefault();
      e.stopPropagation();
      this.send();
      return;
    }
    if (key === 'Escape') {
      // Vanilla closes the whole line on Escape; the suggestion popup goes
      // with it rather than swallowing the first press.
      e.preventDefault();
      e.stopPropagation();
      this.closeInput();
      return;
    }
    if (key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      this._complete(e.shiftKey ? -1 : 1);
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const dir = key === 'ArrowUp' ? -1 : 1;
      if (this.suggestions.length > 1 && !this.suggestEl.hidden) {
        e.preventDefault();
        e.stopPropagation();
        this._moveSuggestion(dir, true);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this._recallHistory(dir);
      return;
    }
    if (key === 'PageUp' || key === 'PageDown') {
      e.preventDefault();
      const step = this._lineHeight() * 6;
      this.logEl.scrollTop += (key === 'PageUp' ? -step : step);
      return;
    }
    e.stopPropagation();
  }

  _onInput() {
    // Swallow the very first character when it is the key that opened us.
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now < this._guardUntil) {
      const v = this.field.value;
      const g = this._guardValue;
      if (v.length === g.length + 1) {
        const extra = v[v.length - 1];
        if (extra === '/' || extra === 't' || extra === 'T') {
          this.field.value = g;
          try { this.field.setSelectionRange(g.length, g.length); } catch { /* optional */ }
        }
      }
      this._guardUntil = 0;
    }
    this.historyIndex = -1;
    this._cycling = false;
    this.draft = this.field.value;
    this._updateSuggestions();
  }

  _insertAtCaret(text) {
    const f = this.field;
    const start = f.selectionStart == null ? f.value.length : f.selectionStart;
    const end = f.selectionEnd == null ? start : f.selectionEnd;
    f.value = f.value.slice(0, start) + text + f.value.slice(end);
    const caret = start + text.length;
    try { f.setSelectionRange(caret, caret); } catch { /* optional */ }
    this._updateSuggestions();
  }

  _recallHistory(dir) {
    if (!this.history.length) return;
    this._cycling = false;
    if (this.historyIndex === -1) {
      this.draft = this.field.value;
      this.historyIndex = this.history.length;
    }
    this.historyIndex = clamp(this.historyIndex + dir, 0, this.history.length);
    const v = this.historyIndex >= this.history.length ? this.draft : this.history[this.historyIndex];
    this.field.value = v;
    try { this.field.setSelectionRange(v.length, v.length); } catch { /* optional */ }
    this._updateSuggestions();
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------
  /** Where the caret is, and what is being typed there. */
  _context() {
    const v = this.field.value;
    const caret = this.field.selectionStart == null ? v.length : this.field.selectionStart;
    if (v[0] !== '/') return null;
    const upto = v.slice(0, caret);
    const sp = upto.lastIndexOf(' ');
    const tokenStart = sp < 0 ? 1 : sp + 1;
    const token = upto.slice(tokenStart);
    const before = upto.slice(1, tokenStart);
    const words = tokenize(before);
    const argIndex = words.length;      // 0 while still typing the command name
    return { token, tokenStart, caret, words, argIndex };
  }

  _updateSuggestions() {
    const ctx = this._context();
    if (!ctx) { this._hideSuggestions(); return; }
    let pool = [];
    if (ctx.argIndex === 0) {
      pool = commandNames();
    } else {
      const entry = lookupCommand(ctx.words[0]);
      pool = candidatesFor(entry, ctx.argIndex, ctx.words.slice(1));
    }
    const q = normalizeName(ctx.token);
    let list;
    if (!q) {
      list = ctx.argIndex === 0 ? pool.slice(0, 60) : [];
    } else {
      const pre = [];
      const sub = [];
      for (let i = 0; i < pool.length; i++) {
        const n = pool[i];
        const ln = String(n).toLowerCase();
        if (ln.startsWith(q)) pre.push(n);
        else if (ln.indexOf(q) >= 0) sub.push(n);
        if (pre.length >= 60) break;
      }
      pre.sort((a, b) => a.length - b.length);
      sub.sort((a, b) => a.length - b.length);
      list = pre.concat(sub).slice(0, 60);
    }
    this._tokenStart = ctx.tokenStart;
    this._tokenEnd = ctx.caret;
    this.suggestions = list;
    if (!list.length) { this._hideSuggestions(); return; }
    if (this.suggestIndex >= list.length) this.suggestIndex = 0;
    if (this.suggestIndex < 0) this.suggestIndex = 0;
    this._renderSuggestions();
  }

  _renderSuggestions() {
    const shown = this.suggestions.slice(0, MAX_SUGGESTIONS);
    const sig = shown.join('') + '|' + this.suggestIndex + '|' + this.suggestions.length;
    if (sig !== this._suggestSig) {
      this._suggestSig = sig;
      this.suggestEl.textContent = '';
      for (let i = 0; i < shown.length; i++) {
        const row = el('div', 'chat-suggestion' + (i === this.suggestIndex ? ' selected' : ''), this.suggestEl, shown[i]);
        row.addEventListener('click', () => {
          this.suggestIndex = i;
          this._applySuggestion(shown[i], true);
        });
      }
      if (this.suggestions.length > shown.length) {
        el('div', 'chat-suggestion', this.suggestEl, `… ${this.suggestions.length - shown.length} more`);
      }
    }
    this.suggestEl.hidden = false;
  }

  _hideSuggestions() {
    this.suggestions = [];
    this.suggestIndex = -1;
    this._suggestSig = '';
    this._cycling = false;
    if (this.suggestEl) {
      this.suggestEl.hidden = true;
      this.suggestEl.textContent = '';
    }
  }

  _moveSuggestion(dir, apply = false) {
    const n = this.suggestions.length;
    if (!n) return;
    this.suggestIndex = ((this.suggestIndex + dir) % n + n) % n;
    this._suggestSig = '';
    this._renderSuggestions();
    if (apply) {
      this._cycling = true;
      this._applySuggestion(this.suggestions[this.suggestIndex], false);
    }
  }

  /**
   * Tab: first press extends to the longest common prefix, and once there is
   * nothing left to extend, further presses cycle through the candidates.
   */
  _complete(dir) {
    const ctx = this._context();
    if (!ctx) return;
    if (!this._cycling) this._updateSuggestions();
    const list = this.suggestions;
    if (!list.length) return;
    if (list.length === 1) {
      this._applySuggestion(list[0], true);
      this._cycling = false;
      return;
    }
    if (!this._cycling) {
      const common = commonPrefix(list);
      if (common.length > ctx.token.length && common.toLowerCase().startsWith(normalizeName(ctx.token))) {
        this._applySuggestion(common, false);
        this._updateSuggestions();
        return;
      }
      this.suggestIndex = dir > 0 ? 0 : list.length - 1;
      this._cycling = true;
      this._suggestSig = '';
      this._renderSuggestions();
    } else {
      this._moveSuggestion(dir);
    }
    this._applySuggestion(list[this.suggestIndex], false);
  }

  /** Replaces the token under the caret with `value`. */
  _applySuggestion(value, addSpace) {
    const f = this.field;
    const v = f.value;
    const start = this._tokenStart;
    const end = this._tokenEnd;
    const tail = v.slice(end);
    const insert = value + (addSpace && !tail.startsWith(' ') ? ' ' : '');
    f.value = v.slice(0, start) + insert + tail;
    const caret = start + insert.length;
    try { f.setSelectionRange(caret, caret); } catch { /* optional */ }
    this._tokenEnd = start + value.length;
    this.draft = f.value;
    if (addSpace) this._hideSuggestions();
    else this._renderSuggestions();
  }

  // -------------------------------------------------------------------------
  // Pointer lock plumbing
  // -------------------------------------------------------------------------
  /**
   * main.js pops the pause menu whenever the pointer unlocks. Chat unlocks it
   * on purpose, so wrap that callback and stay quiet while the chat is open.
   */
  _guardLock() {
    const input = Game.input;
    if (!input) return;
    try {
      const cur = input.onLockChange;
      if (cur && cur.__mc67ChatGuard === this) return;
      const self = this;
      const guard = function chatLockGuard(locked) {
        if (!locked && self.open) return undefined;
        if (typeof cur === 'function') return cur.call(this, locked);
        return undefined;
      };
      guard.__mc67ChatGuard = this;
      input.onLockChange = guard;
    } catch { /* optional */ }
  }

  _relock() {
    if (!this._wasLocked) return;
    this._wasLocked = false;
    if (!Game.started || Game.paused || Game.gameOver) return;
    if (this._otherUiOpen()) return;
    try { Game.input && Game.input.requestPointerLock(); } catch { /* optional */ }
  }

  _otherUiOpen() {
    const ui = Game.ui;
    if (!ui) return false;
    try {
      if (ui.screens && typeof ui.screens.isOpen === 'function' && ui.screens.isOpen()) return true;
      if (ui.menu && ui.menu.visible) return true;
    } catch { /* optional */ }
    return false;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------
  /** @param {number} dt seconds since the previous frame */
  update(dt) {
    // A tab that was in the background hands back a huge dt; clamp it so lines
    // do not all expire at once when the player comes back.
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
    this._now += step;

    // TPS estimate, sampled once a second.
    this._tpsTimer += step;
    if (this._tpsTimer >= 1) {
      const ticks = Game.ticks || 0;
      const measured = (ticks - this._tpsBase) / this._tpsTimer;
      this._tps = this._tps * 0.4 + clamp(measured, 0, 40) * 0.6;
      this._tpsBase = ticks;
      this._tpsTimer = 0;
    }

    this._refreshVisibility();

    // A screen or the pause menu takes precedence over the chat line.
    if (this.open && this._otherUiOpen()) this.closeInput();

    // Hold noclip against player.applyMovementInput, which resets it per frame.
    if (this._noclip) {
      const p = Game.player;
      if (p && p.noClip !== true) {
        try {
          Object.defineProperty(p, 'noClip', { configurable: true, get: () => true, set: () => {} });
        } catch { p.noClip = true; }
      }
    }

    if (this.open) {
      const active = document.activeElement;
      if (active !== this.field && (!active || active === document.body || active.tagName === 'CANVAS')) {
        try { this.field.focus({ preventScroll: true }); } catch { /* optional */ }
      }
    } else {
      this._pollOpenKey();
    }

    this._optTimer += step;
    if (this._optTimer > 0.5) { this._optTimer = 0; this._applyOpacity(); }
  }

  _applyOpacity() {
    let v = 1;
    try {
      const s = Game.settings && Game.settings.get('chatOpacity');
      if (typeof s === 'number') v = clamp(s, 0, 1);
    } catch { v = 1; }
    if (v !== this._opacity) {
      this._opacity = v;
      if (this.logEl) this.logEl.style.setProperty('--chat-opacity', String(v));
    }
  }

  /**
   * Fallback for opening the chat. player.js normally does this; both defer by
   * a frame so the keystroke that opened us is never typed into the field.
   */
  _pollOpenKey() {
    const pending = this._pendingOpen;
    if (pending) {
      // A press that never resolved (a screen opened in between) must not sit
      // around waiting to reopen the chat much later.
      if (Game.frame - pending.frame > 3) { this._pendingOpen = null; return; }
      if (Game.frame !== pending.frame) {
        this._pendingOpen = null;
        if (!this._otherUiOpen() && Game.started && !Game.paused) this.openInput(pending.prefix);
      }
      return;
    }
    const input = Game.input;
    if (!input || typeof input.justPressed !== 'function') return;
    if (!Game.started || Game.paused || Game.gameOver) return;
    if (this._otherUiOpen()) return;
    if (input.justPressed('chat')) this._pendingOpen = { prefix: '', frame: Game.frame };
    else if (input.justPressed('command')) this._pendingOpen = { prefix: '/', frame: Game.frame };
  }

  /** Detaches listeners and empties the layer. */
  destroy() {
    try { this.root.removeEventListener('wheel', this._onWheel); } catch { /* optional */ }
    this.clear();
    if (ACTIVE === this) ACTIVE = null;
    this.root.textContent = '';
  }
}

/** Longest shared prefix of a candidate list (case-sensitive). */
function commonPrefix(list) {
  if (!list.length) return '';
  let p = String(list[0]);
  for (let i = 1; i < list.length && p; i++) {
    const s = String(list[i]);
    let j = 0;
    while (j < p.length && j < s.length && p[j] === s[j]) j++;
    p = p.slice(0, j);
  }
  return p;
}

export default Chat;
