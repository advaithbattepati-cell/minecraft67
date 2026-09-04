// ============================================================================
// main.js - Boot sequence, subsystem wiring, and the game loop.
//
// Integration policy: a single broken subsystem must never blank the screen.
// Optional calls go through `safe()`, which logs the first failure per site and
// then stays quiet, so the rest of the game keeps running and the problem is
// visible in the console and the F3 overlay.
// ============================================================================
import * as THREE from 'three';

import { Game } from './core/game.js';
import {
  TICK_MS, DIM_OVERWORLD, DIM_NETHER, DIM_END, GAMEMODE, DIFFICULTY,
  DEFAULT_RENDER_DISTANCE, CHUNK_X, CHUNK_Z, SEA_LEVEL, WORLD_HEIGHT, PLAYER_EYE,
} from './core/constants.js';
import { clamp } from './core/util.js';
import { RNG, hashString } from './core/rng.js';

// ---------------------------------------------------------------------------
// Defensive helpers
// ---------------------------------------------------------------------------
const _failed = new Set();
/** Runs fn, logging the first failure at this call site and swallowing the rest. */
function safe(site, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    if (!_failed.has(site)) {
      _failed.add(site);
      console.error(`[${site}]`, err);
      bootNote(`${site}: ${err && err.message ? err.message : err}`);
    }
    return fallback;
  }
}
const brokenSubsystems = () => [..._failed];

const bootStatusEl = () => document.getElementById('boot-status');
const bootFillEl = () => document.getElementById('boot-bar-fill');
const bootNotes = [];
function bootNote(msg) { bootNotes.push(msg); }
function bootStatus(text, pct) {
  const s = bootStatusEl();
  if (s) s.textContent = text;
  const f = bootFillEl();
  if (f && pct != null) f.style.width = `${clamp(pct, 0, 1) * 100}%`;
}
/** Yields to the browser so the boot bar actually paints between steps. */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// Module loading. Each subsystem is optional at boot time; a missing or broken
// module degrades that feature instead of killing the game.
// ---------------------------------------------------------------------------
const mods = {};
async function loadModules() {
  const specs = [
    ['blocks', './world/blocks.js'],
    ['chunk', './world/chunk.js'],
    ['world', './world/world.js'],
    ['biomes', './world/biomes.js'],
    ['worldgen', './world/worldgen.js'],
    ['features', './world/features.js'],
    ['structures', './world/structures.js'],
    ['lighting', './world/lighting.js'],
    ['blockupdate', './world/blockupdate.js'],
    ['redstone', './world/redstone.js'],
    ['atlas', './render/atlas.js'],
    ['mesher', './render/mesher.js'],
    ['chunkrenderer', './render/chunkrenderer.js'],
    ['sky', './render/sky.js'],
    ['particles', './render/particles.js'],
    ['models', './render/models.js'],
    ['skins', './render/skins.js'],
    ['entityrenderer', './render/entityrenderer.js'],
    ['itemrender', './render/itemrender.js'],
    ['entity', './entity/entity.js'],
    ['player', './entity/player.js'],
    ['mobs', './entity/mobs.js'],
    ['ai', './entity/ai.js'],
    ['projectiles', './entity/projectiles.js'],
    ['itementity', './entity/itementity.js'],
    ['vehicles', './entity/vehicles.js'],
    ['combat', './entity/combat.js'],
    ['spawning', './entity/spawning.js'],
    ['items', './item/items.js'],
    ['inventory', './item/inventory.js'],
    ['recipes', './item/recipes.js'],
    ['smelting', './item/smelting.js'],
    ['brewing', './item/brewing.js'],
    ['enchanting', './item/enchanting.js'],
    ['effects', './item/effects.js'],
    ['loot', './item/loot.js'],
    ['trading', './item/trading.js'],
    ['hud', './ui/hud.js'],
    ['screens', './ui/screens.js'],
    ['menu', './ui/menu.js'],
    ['chat', './ui/chat.js'],
    ['debug', './ui/debug.js'],
    ['sound', './audio/sound.js'],
    ['save', './save/save.js'],
    ['input', './core/input.js'],
    ['settings', './core/settings.js'],
  ];
  let done = 0;
  await Promise.all(specs.map(async ([key, path]) => {
    try {
      mods[key] = await import(path);
    } catch (err) {
      mods[key] = null;
      _failed.add('load:' + key);
      console.error(`[load:${key}] ${path}`, err);
      bootNote(`failed to load ${path}: ${err && err.message}`);
    } finally {
      done++;
      bootStatus(`Loading modules ${done}/${specs.length}`, 0.05 + 0.35 * (done / specs.length));
    }
  }));
  return mods;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x87ceeb, 1);
  renderer.sortObjects = true;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = true;
  return renderer;
}

function onResize() {
  if (!Game.renderer || !Game.camera) return;
  const w = window.innerWidth, h = window.innerHeight;
  Game.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  Game.renderer.setSize(w, h, false);
  Game.camera.aspect = w / h;
  Game.camera.updateProjectionMatrix();
  Game.emit('resize', w, h);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let booted = false;

async function boot() {
  if (booted) return;
  booted = true;

  bootStatus('Loading modules', 0.02);
  await loadModules();
  await nextFrame();

  // --- settings ---
  bootStatus('Reading settings', 0.42);
  Game.settings = safe('settings', () => {
    const s = new mods.settings.Settings();
    if (typeof s.load === 'function') s.load();
    return s;
  }, { get: () => undefined, set: () => {}, values: {} });

  const setting = (key, dflt) => {
    const v = safe('settings.get', () => Game.settings.get(key), undefined);
    return v === undefined || v === null ? dflt : v;
  };

  // --- renderer / scene / camera ---
  bootStatus('Starting renderer', 0.46);
  const canvas = document.getElementById('game-canvas');
  Game.renderer = createRenderer(canvas);
  Game.camera = new THREE.PerspectiveCamera(
    setting('fov', 70), window.innerWidth / window.innerHeight, 0.05, 1200,
  );
  Game.camera.rotation.order = 'YXZ';
  Game.scene = new THREE.Scene();
  Game.clock = new THREE.Clock();
  window.addEventListener('resize', onResize);
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    Game.paused = true;
    Game.log('Graphics context lost. Reload the page to continue.');
  });

  // --- texture atlas ---
  bootStatus('Painting textures', 0.5);
  await nextFrame();
  Game.atlas = safe('atlas', () => mods.atlas.buildAtlas(), null);
  await nextFrame();

  // --- audio ---
  bootStatus('Tuning sound', 0.62);
  Game.audio = safe('audio', () => new mods.sound.SoundEngine(), null);

  // --- input ---
  bootStatus('Binding controls', 0.66);
  Game.input = safe('input', () => new mods.input.Input(canvas), null);

  // --- renderers that need the atlas ---
  bootStatus('Building renderers', 0.72);
  Game.chunkRenderer = safe('chunkRenderer', () => new mods.chunkrenderer.ChunkRenderer(Game.scene), null);
  Game.entityRenderer = safe('entityRenderer', () => new mods.entityrenderer.EntityRenderer(Game.scene), null);
  Game.particles = safe('particles', () => new mods.particles.Particles(Game.scene), null);
  Game.sky = safe('sky', () => new mods.sky.Sky(Game.scene, Game.camera), null);
  Game.heldItem = safe('heldItem', () => new mods.itemrender.HeldItemView(Game.camera), null);

  // --- UI ---
  bootStatus('Drawing interface', 0.82);
  const uiRoot = document.getElementById('ui-root');
  Game.ui = {
    hud: safe('hud', () => new mods.hud.HUD(document.getElementById('hud')), null),
    screens: safe('screens', () => new mods.screens.Screens(document.getElementById('screens')), null),
    menu: safe('menu', () => new mods.menu.Menu(document.getElementById('menu-layer')), null),
    chat: safe('chat', () => new mods.chat.Chat(document.getElementById('chat-layer')), null),
    debug: safe('debug', () => new mods.debug.DebugOverlay(document.getElementById('debug-layer')), null),
    root: uiRoot,
  };

  // --- persistence ---
  bootStatus('Opening save storage', 0.9);
  Game.save = safe('save', () => new mods.save.SaveManager(), null);
  if (Game.save && typeof Game.save.init === 'function') {
    await safe('save.init', () => Game.save.init(), null);
  }

  wireEvents();

  bootStatus('Ready', 1);
  Game.emit('boot');

  // Reveal the title screen and hide the boot overlay.
  const bootScreen = document.getElementById('boot-screen');
  if (bootScreen) {
    bootScreen.classList.add('hidden');
    setTimeout(() => { bootScreen.style.display = 'none'; }, 600);
  }
  safe('menu.showTitle', () => Game.ui.menu.showTitle(), null);

  Game.running = true;
  requestAnimationFrame(frame);
  window.__gameReady = true;
  if (brokenSubsystems().length) {
    console.warn('minecraft67 booted with degraded subsystems:', brokenSubsystems());
  }
}

// ---------------------------------------------------------------------------
// Event wiring between subsystems
// ---------------------------------------------------------------------------
function wireEvents() {
  // save.js only writes chunks it has been told changed, and nothing was
  // telling it, so every block edit was dropped on reload.
  Game.on('blockchange', (x, y, z) => {
    if (!Game.save || !Game.world) return;
    const c = Game.world.chunkAt(x, z);
    if (c) safe('save.markDirty', () => Game.save.markChunkModified(c), null);
  });

  Game.on('toast', (text) => safe('hud.toast', () => Game.ui.hud.setActionBar(text), null));
  Game.on('chat', (text) => safe('chat.add', () => Game.ui.chat.addMessage(text), null));

  Game.on('dimensionchange', (from, to) => switchDimension(to));

  Game.on('pause', () => {
    Game.paused = true;
    safe('input.unlock', () => Game.input.exitPointerLock(), null);
  });
  Game.on('resume', () => { Game.paused = false; });

  Game.on('settingschange', (key, value) => {
    if (key === 'fov' && Game.camera) { Game.camera.fov = value; Game.camera.updateProjectionMatrix(); }
    if (key === 'renderDistance') safe('rd', () => Game.chunkRenderer.setRenderDistance(value), null);
    if (key === 'guiScale') document.documentElement.style.setProperty('--gui-scale', String(value));
    if (key === 'smoothLighting') {
      const on = value !== false;
      for (const k in Game.worlds) Game.worlds[k].smoothLighting = on;
      // Meshes already built keep their old lighting until something
      // invalidates them; rebuild in place rather than clearing, which would
      // dispose the GPU buffers and pop the whole world back in.
      safe('smoothRemesh', () => Game.chunkRenderer.invalidateAll(), null);
    }
  });

  // Pointer lock drives pause so the player never fights an invisible cursor.
  if (Game.input) {
    Game.input.onLockChange = (locked) => {
      // A lock request refused outright (no user gesture, headless, or a browser
      // policy) must not pause a game the player just started.
      if (!locked && Game.started && !Game.gameOver && Game.time - lastStartTime > 1) {
        const screenOpen = safe('screens.isOpen', () => Game.ui.screens.isOpen(), false);
        const menuOpen = safe('menu.visible', () => Game.ui.menu.visible, false);
        if (!screenOpen && !menuOpen) safe('menu.pause', () => Game.ui.menu.showPause(), null);
      }
    };
  }

  Game.on('playerdeath', () => {
    Game.gameOver = true;
    safe('menu.death', () => Game.ui.menu.showDeath(), null);
  });
  Game.on('playerrespawn', () => { Game.gameOver = false; });

  window.addEventListener('beforeunload', () => {
    if (Game.started && Game.save) {
      try { Game.save.saveWorld(Game, Game.worldName); } catch { /* best effort */ }
    }
  });
}

// ---------------------------------------------------------------------------
// World lifecycle
// ---------------------------------------------------------------------------
/**
 * Creates a brand new world and drops the player into it.
 * @param {{name?:string, seed?:number|string, mode?:string, difficulty?:number,
 *          generateStructures?:boolean, bonusChest?:boolean}} opts
 */
async function startNewWorld(opts = {}) {
  const seedInput = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  let seed;
  if (typeof seedInput === 'string' && seedInput.trim() !== '') {
    const t = seedInput.trim();
    seed = /^-?\d+$/.test(t) ? Number(t) : hashString(t);
  } else if (Number.isFinite(Number(seedInput))) {
    // Number(0) is falsy, and the old `||` fallback quietly regenerated a saved
    // seed-0 world with a fresh random seed on every load.
    seed = Number(seedInput);
  } else {
    seed = Math.floor(Math.random() * 2 ** 31);
  }

  Game.seed = seed >>> 0;
  Game.worldName = opts.name || 'New World';
  Game.mode = opts.mode || GAMEMODE.SURVIVAL;
  Game.difficulty = opts.difficulty ?? DIFFICULTY.NORMAL;
  Game.gameOver = false;

  safe('menu.hide', () => Game.ui.menu.hide(), null);
  bootStatus('Generating world', 0);
  const bootScreen = document.getElementById('boot-screen');
  if (bootScreen) { bootScreen.style.display = ''; bootScreen.classList.remove('hidden'); }
  await nextFrame();

  // Build the three dimensions.
  Game.worlds = Object.create(null);
  for (const dim of [DIM_OVERWORLD, DIM_NETHER, DIM_END]) {
    const w = safe('createWorld:' + dim, () => {
      const gen = mods.worldgen.createGenerator(Game.seed, dim);
      return new mods.world.World({ seed: Game.seed, dimension: dim, generator: gen });
    }, null);
    if (w) {
      // mesher.js reads world.smoothLighting; nothing ever set it, so the
      // Smooth Lighting option was inert. Set it on every dimension, or it
      // silently reverts after a trip through a portal.
      w.smoothLighting = safe('smoothSetting', () => Game.settings.get('smoothLighting'), true) !== false;
      if (opts.generateStructures === false && w.generator) w.generator.generateStructures = false;
      Game.worlds[dim] = w;
    }
  }

  // Put saved chunks back before anything generates the spawn area, so an
  // edited world reloads as the player left it instead of being regenerated.
  if (opts.restoreChunks) await restoreSavedChunks(opts.name);
  Game.world = Game.worlds[DIM_OVERWORLD];
  Game.dimension = DIM_OVERWORLD;
  if (!Game.world) {
    bootStatus('World generation unavailable', 1);
    console.error('No world could be created; check world/world.js and world/worldgen.js');
    return;
  }

  // Pre-generate the spawn area so the player does not fall through the floor.
  const spawn = safe('findSpawn', () => Game.world.generator.findSpawn(Game.world), null)
    || { x: 0.5, y: SEA_LEVEL + 2, z: 0.5 };
  Game.world.spawnPoint = { ...spawn };

  const pre = 3;
  const cx0 = Math.floor(spawn.x / CHUNK_X), cz0 = Math.floor(spawn.z / CHUNK_Z);
  let count = 0;
  const total = (pre * 2 + 1) ** 2;
  for (let dz = -pre; dz <= pre; dz++) {
    for (let dx = -pre; dx <= pre; dx++) {
      safe('ensureChunk', () => Game.world.ensureChunk(cx0 + dx, cz0 + dz), null);
      count++;
      if (count % 7 === 0) { bootStatus(`Generating world ${Math.round(100 * count / total)}%`, count / total); await nextFrame(); }
    }
  }

  // Drop the player onto the surface.
  const groundY = safe('getHeight', () => Game.world.getHeight(Math.floor(spawn.x), Math.floor(spawn.z)), spawn.y);
  const py = clamp((groundY ?? spawn.y) + 1, 1, WORLD_HEIGHT - 3);
  Game.player = safe('player', () => new mods.player.Player(Game.world, spawn.x, py, spawn.z), null);
  if (Game.player) {
    Game.player.gameMode = Game.mode;
    Game.player.respawnPoint = { ...Game.world.spawnPoint };
    safe('world.addEntity', () => Game.world.addEntity(Game.player), null);
    if (Game.mode === GAMEMODE.CREATIVE) Game.player.canFly = true;
  }

  Game.ticks = 0;
  Game.started = true;
  Game.paused = false;
  lastStartTime = Game.time;
  Game.emit('worldloaded', Game.world);

  safe('audio.init', () => Game.audio.init(), null);
  safe('hud.show', () => Game.ui.hud.show(), null);
  safe('input.lock', () => Game.input.requestPointerLock(), null);

  if (bootScreen) {
    bootScreen.classList.add('hidden');
    setTimeout(() => { bootScreen.style.display = 'none'; }, 600);
  }
  Game.log(`Welcome to ${Game.worldName}. Seed: ${Game.seed}`);
}

/**
 * Reads every stored chunk for a world and drops it into the matching dimension.
 * Only modified chunks are ever written, so this is a small set; everything else
 * is regenerated from the seed.
 */
async function restoreSavedChunks(name) {
  if (!Game.save || typeof Game.save.loadWorldChunks !== 'function') return 0;
  const Chunk = mods.chunk && mods.chunk.Chunk;
  if (!Chunk || typeof Chunk.deserialize !== 'function') return 0;
  const rows = await safe('save.loadChunks', () => Game.save.loadWorldChunks(name), []) || [];
  let restored = 0;
  for (const rec of rows) {
    const w = Game.worlds[rec.dimension || rec.dim || DIM_OVERWORLD];
    if (!w) continue;
    const chunk = safe('save.deserializeChunk', () => Chunk.deserialize(rec, w), null);
    if (!chunk) continue;
    w.addChunk(chunk);
    restored++;
  }
  if (restored) bootStatus(`Restoring ${restored} saved chunks`, 0.5);
  return restored;
}

/** Loads a previously saved world by name. */
async function loadSavedWorld(name) {
  const data = await safe('save.load', () => Game.save.loadWorld(name), null);
  if (!data) { Game.log(`Could not load world "${name}".`); return; }
  await startNewWorld({
    name, seed: data.seed, mode: data.mode, difficulty: data.difficulty,
    restoreChunks: true,
  });
  safe('save.restore', () => {
    // applyWorldSave restores time, weather and the spawn point per dimension.
    const apply = mods.save && mods.save.applyWorldSave;
    if (apply) for (const dim in Game.worlds) apply(Game.worlds[dim], data, dim);
    else if (data.time != null && Game.world) Game.world.time = data.time;
    if (data.player && Game.player && typeof Game.player.load === 'function') Game.player.load(data.player);
  }, null);
}

/** Moves the player between dimensions, creating the destination world if needed. */
function switchDimension(to) {
  const target = Game.worlds[to];
  if (!target || target === Game.world) return;
  const from = Game.world;
  safe('dim.remove', () => from.removeEntity(Game.player), null);
  Game.world = target;
  Game.dimension = to;
  // addEntity assigns .world itself; assigning it here first would hide the
  // previous world from addEntity's cross-world detach guard.
  if (Game.player) safe('dim.add', () => target.addEntity(Game.player), null);
  safe('chunkRenderer.clear', () => Game.chunkRenderer.clear(), null);
  safe('entityRenderer.clear', () => Game.entityRenderer.clear(), null);
  safe('sky.dim', () => Game.sky.setDimension(to), null);
  Game.emit('worldloaded', target);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------
let lastStartTime = -Infinity;
let lastTime = 0;
let tickAccumulator = 0;
let fpsAccum = 0, fpsFrames = 0, fpsTimer = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (!Game.running) return;

  const frameStart = performance.now();
  const dtRaw = lastTime ? (now - lastTime) / 1000 : 0;
  lastTime = now;
  // Clamp so a background tab or a long GC pause cannot teleport entities.
  const dt = Math.min(dtRaw, 0.1);
  Game.dt = dt;
  Game.time += dt;
  Game.frame++;

  const active = Game.started && !Game.paused && Game.world;

  // --- input ---------------------------------------------------------------
  if (Game.input && active && Game.player) {
    safe('player.input', () => Game.player.handleInput(Game.input, dt), null);
  }
  if (Game.input) safe('ui.input', () => handleGlobalKeys(), null);

  // --- fixed 20 Hz simulation ---------------------------------------------
  if (active) {
    tickAccumulator += dt * 1000;
    let ticksThisFrame = 0;
    const tickStart = performance.now();
    while (tickAccumulator >= TICK_MS && ticksThisFrame < 5) {
      tickAccumulator -= TICK_MS;
      ticksThisFrame++;
      Game.ticks++;
      safe('world.tick', () => Game.world.tick(TICK_MS / 1000), null);
      Game.emit('tick', Game.ticks);
    }
    // A very long stall would otherwise build an unbounded backlog.
    if (tickAccumulator > TICK_MS * 10) tickAccumulator = 0;
    Game.stats.tickMs = performance.now() - tickStart;
  }

  // --- variable-rate updates ----------------------------------------------
  if (active) {
    safe('player.update', () => Game.player && Game.player.update(dt), null);
    safe('entities.update', () => {
      const list = Game.world.entities;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e !== Game.player && !e.removed) e.update(dt);
      }
    }, null);
  }

  // --- streaming: generation, lighting, meshing ----------------------------
  if (active) {
    // Spend more of the frame on streaming while there is a visible backlog,
    // so a fresh world fills in quickly, then back off to stay smooth.
    const backlog = Game.stats.chunksQueued | 0;
    const meshBudget = backlog > 32 ? 16 : backlog > 8 ? 10 : 6;
    const genBudget = Game.world.pendingCount > 16 ? 8 : 5;
    const t0 = performance.now();
    safe('chunkQueue', () => Game.world.processChunkQueue(genBudget), null);
    Game.stats.genMs = performance.now() - t0;
    safe('lightQueue', () => mods.lighting.processLightQueue(Game.world, 3), null);
    safe('chunkRender', () => Game.chunkRenderer.update(Game.world, Game.player, meshBudget), null);
  }

  // --- camera --------------------------------------------------------------
  if (Game.player && Game.camera) safe('camera', () => updateCamera(dt), null);

  // --- visuals -------------------------------------------------------------
  if (Game.world) {
    safe('sky.update', () => Game.sky.update(Game.world, dt), null);
    safe('entityRender', () => Game.entityRenderer.update(Game.world, dt, Game.camera), null);
    safe('particles.update', () => Game.particles.update(dt, Game.camera), null);
    safe('held.update', () => Game.heldItem.update(Game.player, dt), null);
  }
  if (Game.audio && Game.player) {
    safe('audio.listener', () => Game.audio.setListener(Game.player.x, Game.player.y, Game.player.z, Game.player.yaw), null);
  }

  // --- UI ------------------------------------------------------------------
  safe('hud.update', () => Game.ui.hud && Game.ui.hud.update(dt), null);
  safe('screens.update', () => Game.ui.screens && Game.ui.screens.update(dt), null);
  safe('chat.update', () => Game.ui.chat && Game.ui.chat.update(dt), null);
  safe('debug.update', () => Game.ui.debug && Game.ui.debug.update(dt), null);

  // --- render --------------------------------------------------------------
  safe('render', () => Game.renderer.render(Game.scene, Game.camera), null);

  if (Game.input) safe('input.consume', () => Game.input.consume(), null);

  // save.js implements its own 30-second cadence; it just needs pumping.
  if (active && Game.save) safe('autosave', () => Game.save.autoSaveTick(Game), null);

  // --- stats ---------------------------------------------------------------
  const frameMs = performance.now() - frameStart;
  Game.stats.frameMs = frameMs;
  fpsAccum += dt; fpsFrames++; fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    Game.stats.fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0; fpsFrames = 0; fpsTimer = 0;
    if (Game.renderer) {
      Game.stats.drawCalls = Game.renderer.info.render.calls;
      Game.stats.triangles = Game.renderer.info.render.triangles;
    }
    if (Game.world) {
      Game.stats.chunksLoaded = Game.world.chunks.size;
      Game.stats.entities = Game.world.entities.length;
    }
  }
}

/**
 * Camera placement.
 *
 * The engine uses Minecraft's angle convention throughout - entities, items,
 * mobs, AI and audio all take the look vector to be
 *     (-sin(yaw)cos(pitch), -sin(pitch), cos(yaw)cos(pitch)).
 * The three.js YXZ Euler that points a camera the same way is
 * (-pitch, PI - yaw), NOT (pitch, yaw): the naive version is mirrored in both
 * Y and Z, so the player would mine and walk opposite to the view. Player
 * re-asserts this at matrix-update time; deriving it identically here keeps the
 * two in agreement instead of fighting each other.
 */
let perspective = 0; // 0 first person, 1 third back, 2 third front
function updateCamera(dt) {
  const p = Game.player;
  const cam = Game.camera;
  const eye = p.eyeHeight ?? PLAYER_EYE;
  const eyeY = p.y + eye;

  const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
  const fx = -Math.sin(p.yaw) * cp, fy = -sp, fz = Math.cos(p.yaw) * cp;

  let bobX = 0, bobY = 0;
  const bobEnabled = safe('bobSetting', () => Game.settings.get('viewBobbing'), true);
  if (bobEnabled && p.onGround && perspective === 0) {
    const speed = Math.hypot(p.vx, p.vz);
    const t = Game.time * 10;
    const amt = Math.min(speed / 4, 1);
    bobX = Math.cos(t) * 0.03 * amt;
    bobY = Math.abs(Math.sin(t)) * 0.04 * amt;
  }

  if (perspective === 0) {
    cam.position.set(p.x + bobX, eyeY + bobY, p.z);
    cam.rotation.set(-p.pitch, Math.PI - p.yaw, 0, 'YXZ');
  } else if (perspective === 1) {
    const d = 4;                       // behind the player, looking forward
    cam.position.set(p.x - fx * d, eyeY - fy * d, p.z - fz * d);
    cam.rotation.set(-p.pitch, Math.PI - p.yaw, 0, 'YXZ');
  } else {
    const d = 4;                       // in front, looking back at the player
    cam.position.set(p.x + fx * d, eyeY + fy * d, p.z + fz * d);
    cam.rotation.set(p.pitch, -p.yaw, 0, 'YXZ');
  }
}

/** Global hotkeys that are not part of player movement. */
function handleGlobalKeys() {
  const input = Game.input;
  if (!input || typeof input.justPressed !== 'function') return;
  if (input.justPressed('debug')) safe('debug.toggle', () => Game.ui.debug.toggle(), null);
  if (input.justPressed('perspective')) perspective = (perspective + 1) % 3;
  if (input.justPressed('screenshot')) takeScreenshot();
}

function takeScreenshot() {
  safe('screenshot', () => {
    Game.renderer.render(Game.scene, Game.camera);
    const url = Game.renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `minecraft67-${Date.now()}.png`;
    a.click();
    Game.toast('Screenshot saved');
  }, null);
}

// ---------------------------------------------------------------------------
// Public surface: the menus and the automated tests both drive the game here.
// ---------------------------------------------------------------------------
function registryCounts() {
  const n = (o) => (o ? (Array.isArray(o) ? o.filter(Boolean).length : (o.size ?? Object.keys(o).length)) : 0);
  return {
    blocks: n(mods.blocks && mods.blocks.BLOCKS),
    items: n(mods.items && mods.items.ITEMS),
    mobs: n(mods.mobs && mods.mobs.MOBS),
    biomes: n(mods.biomes && mods.biomes.BIOMES),
    recipes: n(mods.recipes && mods.recipes.RECIPES),
    textures: n(mods.atlas && mods.atlas.TEXTURE_NAMES),
    effects: n(mods.effects && mods.effects.EFFECTS),
    enchantments: n(mods.enchanting && mods.enchanting.ENCHANTMENTS),
    structures: n(mods.structures && mods.structures.STRUCTURES),
    features: n(mods.features && mods.features.FEATURES),
    models: n(mods.models && mods.models.MODELS),
    sounds: n(mods.sound && mods.sound.SOUNDS),
  };
}

const api = {
  Game,
  THREE,
  mods,
  startNewWorld,
  loadSavedWorld,
  switchDimension,
  counts: registryCounts,
  broken: brokenSubsystems,
  bootNotes,
  setPerspective: (n) => { perspective = n % 3; },
  /** Resumes play, closing any menu. Safe to call when already running. */
  resume() {
    safe('api.menuHide', () => Game.ui.menu.hide(), null);
    Game.paused = false;
    Game.emit('resume');
  },
  /**
   * Used by tools/verify.mjs to boot straight into a world without clicking.
   * Headless browsers deny pointer lock (there is no user gesture), which would
   * otherwise trip the auto-pause and freeze the simulation, so resume explicitly.
   */
  async quickStart(opts) {
    await startNewWorld({ name: 'Test World', seed: 12345, mode: GAMEMODE.SURVIVAL, ...opts });
    api.resume();
    return true;
  },
};
window.__mc = api;
export default api;
export { boot, startNewWorld, loadSavedWorld, switchDimension };

// ---------------------------------------------------------------------------
boot().catch((err) => {
  console.error('Fatal boot error', err);
  window.__bootError = String(err && err.message || err);
  bootStatus('Error: ' + window.__bootError, 1);
});
