// ============================================================================
// player.js - The Player entity: input, movement feel, mining, building,
// combat, hunger, XP, sleeping, death and respawn.
//
// This is the file the player actually feels, so it follows vanilla's numbers
// wherever they are known:
//   * movement is acceleration based - every state (walk / sprint / sneak /
//     swim / fly / climb) picks a target speed, and the per-tick friction of
//     the block underfoot decides how fast you reach it and how far you slide.
//   * mining uses the real speed formula (tool speed / hardness / 30, or / 100
//     when the tool cannot harvest the block) with efficiency, haste, aqua
//     affinity and the airborne penalty folded in.
//   * combat uses the 1.9+ cooldown curve, crits, sweeping edge and knockback.
//
// LOOK CONVENTION
// ---------------
// `yaw` / `pitch` are Minecraft's: yaw 0 looks towards +Z, yaw grows clockwise
// (to the player's right), pitch grows downwards, and the look vector is
//     (-sin(yaw) * cos(pitch), -sin(pitch), cos(yaw) * cos(pitch))
// which is exactly what entity.js, items.js, mobs.js, ai.js and sound.js all
// assume. The three.js camera in main.js is fed the raw (pitch, yaw) pair in
// 'YXZ' order, which describes a *different* orientation (it looks towards -Z
// and treats positive pitch as up), so the player owns the final camera
// transform: `_installCameraFix()` re-aims the camera from these angles at
// matrix-update time. See `_aimCamera()` for the exact conversion.
// ============================================================================
import {
  TICKS_PER_SECOND, WORLD_HEIGHT, SEA_LEVEL, MAX_HEALTH, MAX_HUNGER, MAX_AIR,
  PLAYER_WIDTH, PLAYER_HEIGHT, PLAYER_EYE, PLAYER_EYE_SNEAK, SNEAK_HEIGHT, STEP_HEIGHT,
  WALK_SPEED, SPRINT_SPEED, SNEAK_SPEED, FLY_SPEED, SWIM_SPEED, JUMP_VELOCITY,
  REACH_SURVIVAL, REACH_CREATIVE, GAMEMODE, DIFFICULTY, HOTBAR_SIZE,
  FACE_DOWN, FACE_UP, FACE_DIRS, HFACE_DIRS, HFACE_TO_FACE, DIM_OVERWORLD,
  ARMOR_HEAD, ARMOR_FEET,
} from '../core/constants.js';
import { clamp, AABB, angleDiff, prettyName } from '../core/util.js';
import { Game } from '../core/game.js';
import { LivingEntity, EQUIP, registerEntityType } from './entity.js';
import { getBlock, blockByName } from '../world/blocks.js';
import {
  PlayerInventory, Inventory, isEmpty, copyStack, damageStack,
} from '../item/inventory.js';
import { getItem } from '../item/items.js';
import { blockDrops, blockXP, canHarvest } from '../item/loot.js';
import {
  getEnchant, bonusDamage, knockbackBonus, fireAspectSeconds, mendingRepair,
} from '../item/enchanting.js';
import {
  miningSpeedMultiplier, jumpMultiplier, speedMultiplier, attackDamageBonus,
  attackSpeedMultiplier, maxHealthBonus, clearEffects, triggerDeathEffects,
} from '../item/effects.js';

// ---------------------------------------------------------------------------
// Optional siblings. These modules sit above player.js in the dependency graph
// (or may not exist yet in a partially built tree), so they are pulled in
// lazily and every call site tolerates their absence.
// ---------------------------------------------------------------------------
let _itementity = null;
let _blockupdate = null;
let _combat = null;
let _depsStarted = false;

function loadDeps() {
  if (_depsStarted) return;
  _depsStarted = true;
  const grab = (path, assign) => {
    try { import(path).then(assign).catch(() => { /* optional */ }); } catch { /* no dynamic import */ }
  };
  grab('./itementity.js', (m) => { _itementity = m; });
  grab('../world/blockupdate.js', (m) => { _blockupdate = m; });
  grab('./combat.js', (m) => { _combat = m; });
}
loadDeps();

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Blocks/s^2 of steering available in mid-air (vanilla 0.02 blocks/tick^2). */
const AIR_ACCEL = 8;
/**
 * entity.js damps vertical velocity by 0.98 per tick, which shaves the apex of
 * a JUMP_VELOCITY jump down to ~1.1 blocks. Vanilla's 0.42 impulse already has
 * that damping priced in, so the impulse is scaled back up to land on the
 * classic 1.25-block jump.
 */
const JUMP_DRAG_COMPENSATION = 1.065;
/** Extra forward impulse a sprint jump adds, blocks/s. */
const SPRINT_JUMP_BOOST = 4;
/** Ticks between two allowed jumps. */
const JUMP_DELAY = 6;
/** Ticks between two block placements while the use button is held. */
const PLACE_DELAY = 4;
/** Ticks between two creative block breaks while attack is held. */
const CREATIVE_BREAK_DELAY = 5;
/** Ticks between two "block hit" particle bursts and dig sounds. */
const DIG_SOUND_INTERVAL = 4;
/** Blocks walked between two footstep sounds. */
const STEP_DISTANCE = 2.1;
/** Reach used for entities, which is shorter than the block reach. */
const ATTACK_REACH_SURVIVAL = 3.0;
const ATTACK_REACH_CREATIVE = 5.0;
/** Ticks the food bar takes to convert one saturation/hunger point. */
const REGEN_SLOW_TICKS = 80;
const REGEN_FAST_TICKS = 10;
const STARVE_TICKS = 80;
/** Exhaustion costs, in vanilla units. */
const EXH_SPRINT_PER_BLOCK = 0.1;
const EXH_SWIM_PER_BLOCK = 0.01;
const EXH_JUMP = 0.05;
const EXH_SPRINT_JUMP = 0.2;
const EXH_ATTACK = 0.1;
const EXH_MINE = 0.005;
const EXH_DAMAGE = 0.1;
const EXH_REGEN = 6;
/** How long a full sleep takes before the night is skipped. */
const SLEEP_TICKS = 90;
/** XP dropped on death is capped at this many points. */
const MAX_DEATH_XP = 100;

/** Types that must never soak up a click meant for a block or a mob. */
const NON_TARGET_TYPES = new Set([
  'item', 'item_entity', 'xp_orb', 'experience_orb', 'arrow', 'spectral_arrow',
  'tipped_arrow', 'snowball', 'egg', 'ender_pearl', 'fireball', 'small_fireball',
  'splash_potion', 'lingering_potion', 'experience_bottle', 'fishing_bobber',
  'firework_rocket', 'llama_spit', 'shulker_bullet', 'wither_skull', 'area_effect_cloud',
]);

/** FACE_* -> horizontal facing index (0 N, 1 E, 2 S, 3 W); -1 for up/down. */
const FACE_TO_HFACE = [-1, -1, 0, 2, 3, 1];

/** Blocks whose right click opens a screen, when blockupdate.js is not there. */
const SCREEN_FOR_BLOCK = {
  crafting_table: 'crafting',
  furnace: 'furnace', blast_furnace: 'furnace', smoker: 'furnace',
  chest: 'chest', trapped_chest: 'chest', ender_chest: 'chest', barrel: 'chest',
  enchanting_table: 'enchanting',
  anvil: 'anvil', chipped_anvil: 'anvil', damaged_anvil: 'anvil',
  brewing_stand: 'brewing', beacon: 'beacon', loom: 'loom',
  stonecutter: 'stonecutter', grindstone: 'grindstone',
  smithing_table: 'smithing', cartography_table: 'cartography',
  hopper: 'hopper', dispenser: 'dispenser', dropper: 'dispenser',
  lectern: 'book',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Fire-and-forget positional sound; the audio engine is optional. */
function playAt(name, x, y, z, volume = 1, pitch = 1) {
  const a = Game.audio;
  if (!a || typeof a.playAt !== 'function') return;
  try { a.playAt(name, x, y, z, volume, pitch); } catch { /* optional */ }
}

/** Fire-and-forget particle burst. */
function particles(type, x, y, z, opts) {
  const p = Game.particles;
  if (!p || typeof p.spawn !== 'function') return;
  try { p.spawn(type, x, y, z, opts || {}); } catch { /* optional */ }
}

/** Material name used to build 'step_x' / 'dig_x' / 'place_x' sound names. */
function soundGroup(def) {
  return def && typeof def.sound === 'string' && def.sound ? def.sound : 'stone';
}

/** A damage source shaped the way combat.js hands them around. */
function source(type, entity = null, extra = null) {
  const s = {
    type, entity, direct: entity, amount: 0,
    bypassArmor: false, bypassCooldown: false, bypassInvulnerable: false,
    fire: false, magic: false, projectile: false, fall: false, explosion: false,
  };
  if (extra) for (const k in extra) s[k] = extra[k];
  return s;
}

/** True when the numeric block id can be replaced by a newly placed block. */
function replaceableAt(world, x, y, z) {
  if (!world) return false;
  if (y < 0 || y >= WORLD_HEIGHT) return false;
  const id = world.getBlock(x, y, z);
  if (id === 0) return true;
  const def = getBlock(id);
  return !!def.replaceable;
}

/** Tool information for a held stack, tolerating null and bare names. */
function toolOf(stack) {
  if (isEmpty(stack)) return null;
  const def = getItem(stack.item);
  return def && def.tool ? def.tool : null;
}

const _scratchBox = new AABB();
const _lookVec = { x: 0, y: 0, z: 0 };
const _camVec = { x: 0, y: 0, z: 0 };

// ===========================================================================
// Player
// ===========================================================================

/**
 * The local player. One instance lives on `Game.player`; main.js drives it with
 * `handleInput(input, dt)` once per frame, `update(dt)` once per frame and
 * `tick()` twenty times a second (through the world's entity list).
 */
export class Player extends LivingEntity {
  /**
   * @param {object} world the World to spawn into
   * @param {number} x feet-centre X
   * @param {number} y feet Y
   * @param {number} z feet-centre Z
   */
  constructor(world, x = 0, y = SEA_LEVEL + 1, z = 0) {
    super(world, x, y, z);
    this.type = 'player';
    this.isPlayer = true;
    this.persistent = true;
    this.name = 'Player';
    this.display = 'Player';

    // --- body ---
    this.width = PLAYER_WIDTH;
    this.height = PLAYER_HEIGHT;
    this.eyeHeight = PLAYER_EYE;
    this.stepHeight = STEP_HEIGHT;
    this.maxHealth = MAX_HEALTH;
    this.health = MAX_HEALTH;
    this.hurtSound = 'hurt';
    this.deathSound = 'death';

    // --- inventory ---
    this.inventory = new PlayerInventory('Inventory');
    this.enderChest = new Inventory(27, 'Ender Chest');

    // --- survival state ---
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.foodTimer = 0;
    this.regenTimer = 0;
    this.starveTimer = 0;

    // --- progression ---
    this.xp = 0;              // lifetime points collected
    this.xpLevel = 0;
    this.xpProgress = 0;      // 0..1 across the current level

    // --- modes ---
    this.gameMode = (Game && Game.mode) || GAMEMODE.SURVIVAL;
    this.flying = false;
    this.canFly = this.gameMode === GAMEMODE.CREATIVE || this.gameMode === GAMEMODE.SPECTATOR;
    this.sprinting = false;
    this.sneaking = false;
    this.swimming = false;
    this.crawling = false;

    // --- interaction state ---
    this.breakProgress = 0;                 // 0..1 against breakTarget
    this.breakTarget = null;                // { x, y, z, id, meta }
    this.breakDamageTicks = 0;
    this.breakCooldown = 0;
    this.useTicks = 0;
    this.useDuration = 0;
    this.usingItem = null;                  // the stack currently being used
    this.usingHand = 'mainhand';
    this.useCooldown = 0;
    this.itemCooldowns = new Map();         // item name -> ticks left
    this.hitResult = { block: null, entity: null };
    this.attackIndicator = 1;               // 0..1, drawn under the crosshair
    this.mining = false;

    // --- world bookkeeping ---
    this.respawnPoint = null;
    this.screen = null;                     // name of the open screen, or null
    this.sleeping = false;
    this.sleepPos = null;
    this.sleepTicks = 0;
    this.bobber = null;                     // fishing rod float (items.js owns it)
    this.stats = { blocksMined: 0, blocksPlaced: 0, mobsKilled: 0, deaths: 0, distance: 0, jumps: 0 };

    // --- movement bookkeeping ---
    this.moveForward = 0;
    this.moveStrafe = 0;
    this.jumping = false;
    this.jumpCooldown = 0;
    this.walkDistance = 0;
    this.nextStepDistance = STEP_DISTANCE;
    this.zooming = false;
    this.flySpeedMul = 1;
    this._wasFlyingKey = false;
    this._pendingUI = null;
    this._cameraPatched = false;
    this._lastFov = 0;

    this.attackSpeed = 4;                   // bare hand, in swings per second
    this.xpCooldown = 0;

    // The screens module owns the DOM; the player only mirrors which one is up
    // so movement and mouse look can stop while it is open.
    try {
      Game.on('openscreen', (name) => { this.screen = name || null; });
      Game.on('closescreen', () => { this.screen = null; });
    } catch { /* event bus is optional */ }
  }

  // ---- hotbar plumbing ---------------------------------------------------

  /** Selected hotbar slot, 0..8. Backed by the inventory so both stay in step. */
  get selectedSlot() { return this.inventory ? this.inventory.selected : 0; }
  set selectedSlot(v) {
    if (!this.inventory) return;
    this.inventory.selected = clamp(v | 0, 0, HOTBAR_SIZE - 1);
  }

  /** The stack in the main hand, or null. */
  getHeldItem() { return this.inventory ? this.inventory.getSelected() : null; }
  /** The stack in the off hand, or null. */
  getOffhandItem() { return this.inventory ? this.inventory.getOffhand() : null; }
  /** Replaces the stack in the main hand. */
  setHeldItem(stack) {
    if (!this.inventory) return null;
    return this.inventory.set(this.inventory.selected, stack || null);
  }

  /**
   * @override the six equipment slots read straight through to the inventory,
   * so armour enchantments, knockback resistance and drops all work for free.
   */
  getEquipment(slot) {
    const inv = this.inventory;
    if (!inv) return null;
    if (slot === EQUIP.MAINHAND) return inv.getSelected();
    if (slot === EQUIP.OFFHAND) return inv.getOffhand();
    if (slot >= ARMOR_HEAD && slot <= ARMOR_FEET) return inv.getArmor(slot);
    return null;
  }

  /** @override writes back into the inventory. */
  setEquipment(slot, stack) {
    const inv = this.inventory;
    if (!inv) return;
    if (slot === EQUIP.MAINHAND) inv.set(inv.selected, stack || null);
    else if (slot === EQUIP.OFFHAND) inv.setOffhand(stack || null);
    else if (slot >= ARMOR_HEAD && slot <= ARMOR_FEET) inv.setArmor(slot, stack || null);
  }

  /** Total armour points from the four worn pieces. */
  getArmorPoints() {
    return this.inventory && typeof this.inventory.armorPoints === 'function'
      ? this.inventory.armorPoints() : 0;
  }

  /** Armour toughness from the four worn pieces. */
  getArmorToughness() {
    return this.inventory && typeof this.inventory.armorToughness === 'function'
      ? this.inventory.armorToughness() : 0;
  }

  /** @override folds netherite's knockback resistance in. */
  getKnockbackResist() {
    const inv = this.inventory;
    const armor = inv && typeof inv.armorKnockbackResistance === 'function'
      ? inv.armorKnockbackResistance() : 0;
    return clamp((this.knockbackResist || 0) + armor, 0, 1);
  }

  // ---- geometry / look ---------------------------------------------------

  /**
   * @override the vanilla look vector: yaw 0 faces +Z, positive pitch looks
   * down. Every other module in the project uses this same convention.
   */
  getLookVec(out) {
    const o = out || { x: 0, y: 0, z: 0 };
    const cp = Math.cos(this.pitch);
    o.x = -Math.sin(this.yaw) * cp;
    o.y = -Math.sin(this.pitch);
    o.z = Math.cos(this.yaw) * cp;
    return o;
  }

  /** Horizontal facing index the player is looking along: 0 N, 1 E, 2 S, 3 W. */
  horizontalFacing() {
    const fx = -Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    if (Math.abs(fz) >= Math.abs(fx)) return fz > 0 ? 2 : 0;
    return fx > 0 ? 1 : 3;
  }

  /** Block reach: 4.5 in survival, 5 in creative and spectator. */
  getReach() {
    return (this.gameMode === GAMEMODE.CREATIVE || this.gameMode === GAMEMODE.SPECTATOR)
      ? REACH_CREATIVE : REACH_SURVIVAL;
  }

  /** Entity reach, which vanilla keeps shorter than the block reach. */
  getAttackReach() {
    return this.gameMode === GAMEMODE.CREATIVE ? ATTACK_REACH_CREATIVE : ATTACK_REACH_SURVIVAL;
  }

  /** True while a UI screen or the pause menu owns the input. */
  isScreenOpen() {
    if (this.screen) return true;
    const ui = Game.ui;
    if (!ui) return false;
    try {
      if (ui.screens && typeof ui.screens.isOpen === 'function' && ui.screens.isOpen()) return true;
      if (ui.menu && ui.menu.visible) return true;
      if (ui.chat && ui.chat.isOpen) return true;
    } catch { /* UI is optional */ }
    return false;
  }

  // =========================================================================
  // Input
  // =========================================================================

  /**
   * The single place the Input object is read. Turns raw key/mouse state into
   * intent: look angles, movement targets, hotbar changes, mining, placing and
   * item use. Physics happens later, in `update(dt)`.
   * @param {object} input the Input instance
   * @param {number} dt seconds since the previous frame
   */
  handleInput(input, dt) {
    if (!input) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    this._resolvePendingUI();

    const blocked = this.isScreenOpen() || Game.paused || this.dead || this.sleeping;

    if (blocked) {
      // A screen must not leak movement or mouse look into the world. The
      // deltas are still consumed so nothing snaps when the screen closes.
      if (typeof input.getLook === 'function') input.getLook();
      this.moveForward = 0;
      this.moveStrafe = 0;
      this.jumping = false;
      this.sprinting = false;
      this.mining = false;
      this.cancelMining();
      if (this.usingItem) this.stopUsingItem();
      if (this.sleeping && input.justPressed('jump')) this.wakeUp(true);
      if (!this.isScreenOpen()) this._handleUIKeys(input);
      return;
    }

    // --- mouse look -------------------------------------------------------
    if (typeof input.getLook === 'function') {
      const look = input.getLook();
      if (look && (look.dx || look.dy)) {
        this.yaw += look.dx;
        this.pitch = clamp(this.pitch + look.dy, -Math.PI / 2 + 0.0015, Math.PI / 2 - 0.0015);
        if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
        else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
        this.headYaw = this.yaw;
        this.bodyYaw = this.yaw;
        this.headPitch = this.pitch;
      }
    }

    // --- movement intent --------------------------------------------------
    const mv = typeof input.getMovement === 'function'
      ? input.getMovement()
      : { forward: 0, strafe: 0 };
    this.moveForward = clamp(mv.forward || 0, -1, 1);
    this.moveStrafe = clamp(mv.strafe || 0, -1, 1);

    const spectator = this.gameMode === GAMEMODE.SPECTATOR;
    this.sneaking = !spectator && input.isDown('sneak');
    this.jumping = input.isDown('jump');
    this.zooming = input.isDown('zoom');

    // Sprinting: the key, the double-tap latch, or a hard-pushed touch stick.
    const wantSprint = input.isDown('sprint');
    if (wantSprint && this.moveForward > 0.2 && this.canSprint()) this.sprinting = true;
    if (!wantSprint || this.moveForward <= 0 || !this.canSprint()) {
      this.sprinting = false;
      if (typeof input.clearSprintLatch === 'function' && this.moveForward <= 0) input.clearSprintLatch();
    }

    // --- creative flight --------------------------------------------------
    if (this.canFly && input.justDoubleTapped && input.justDoubleTapped('jump') && !spectator) {
      this.flying = !this.flying;
      if (this.flying) { this.vy = 0; this.fallDistance = 0; }
      Game.toast(this.flying ? 'Flying' : 'Flying disabled');
    }
    if (spectator) this.flying = true;
    if (!this.canFly) this.flying = false;

    // --- hotbar -----------------------------------------------------------
    if (typeof input.hotbarPressed === 'function') {
      const slot = input.hotbarPressed();
      if (slot >= 0 && slot !== this.selectedSlot) this.selectSlot(slot);
    }
    if (input.wheel) {
      const steps = input.wheel > 0 ? Math.ceil(input.wheel) : Math.floor(input.wheel);
      if (steps) this.selectSlot(this.selectedSlot + steps);
    }

    // --- one-shot keys ----------------------------------------------------
    if (input.justPressed('pickBlock')) this.pickBlock();
    if (input.justPressed('dropStack')) this.dropSelected(true);
    else if (input.justPressed('drop')) this.dropSelected(input.ctrl === true);
    if (input.justPressed('offhand')) this.swapOffhand();
    this._handleUIKeys(input);

    // --- attack / mine ----------------------------------------------------
    const target = this.raycastTarget();
    this.hitResult = target;
    const attackDown = input.isDown('attack');
    const attackPressed = input.justPressed('attack');

    if (attackPressed && target.entity && !spectator) {
      this.attack(target.entity);
      this.mining = false;
      this.breakProgress = 0;
      this.breakTarget = null;
    } else if (attackDown && !spectator && !this.usingItem) {
      this.mining = true;
      if (attackPressed && !target.block) this.swingArm();
    } else {
      if (this.mining) this.cancelMining();
      this.mining = false;
    }

    // --- use / place ------------------------------------------------------
    const useDown = input.isDown('use');
    const usePressed = input.justPressed('use');
    if (input.justReleased('use') && this.usingItem) this.stopUsingItem();
    if (!spectator) {
      if (usePressed) {
        this.useCooldown = 0;
        this.useItem();
      } else if (useDown && !this.usingItem && this.useCooldown <= 0) {
        // Holding right click keeps placing, the way vanilla repeats.
        this.useItem();
      }
    }
  }

  /**
   * Interface keys the player owns as a fallback. The UI modules normally take
   * these; the press is remembered for one frame and only acted on when
   * nothing else opened a screen, so a UI that does handle it wins and the key
   * never toggles twice.
   */
  _handleUIKeys(input) {
    if (this._pendingUI) return;
    if (input.justPressed('inventory')) this._pendingUI = { kind: 'inventory', frame: Game.frame };
    else if (input.justPressed('chat')) this._pendingUI = { kind: 'chat', frame: Game.frame };
    else if (input.justPressed('command')) this._pendingUI = { kind: 'command', frame: Game.frame };
  }

  /** Acts on a remembered interface key once the UI has had its chance. */
  _resolvePendingUI() {
    const p = this._pendingUI;
    if (!p) return;
    if (Game.frame === p.frame) return;       // give the UI this frame first
    this._pendingUI = null;
    const ui = Game.ui;
    if (!ui) return;
    try {
      if (p.kind === 'inventory') {
        if (this.isScreenOpen()) return;
        if (ui.screens && typeof ui.screens.open === 'function') {
          ui.screens.open(this.gameMode === GAMEMODE.CREATIVE ? 'creative' : 'inventory', { player: this });
        }
      } else if (ui.chat && typeof ui.chat.openInput === 'function') {
        if (ui.chat.isOpen) return;
        ui.chat.openInput(p.kind === 'command' ? '/' : '');
      }
    } catch { /* the UI module is optional */ }
  }

  /** Blocks an item from being used again for `ticks` ticks (ender pearls). */
  setItemCooldown(itemName, ticks) {
    if (!itemName || !(ticks > 0)) return;
    this.itemCooldowns.set(itemName, Math.round(ticks));
  }

  /** True while `itemName` is still on cooldown. */
  hasItemCooldown(itemName) { return this.itemCooldowns.has(itemName); }

  /** True when the player has the food (and the freedom) to sprint. */
  canSprint() {
    if (this.gameMode === GAMEMODE.SPECTATOR) return true;
    if (this.flying) return true;
    if (this.sneaking || this.usingItem) return false;
    if (this.hasEffect('blindness')) return false;
    return this.hunger > 6 || this.gameMode === GAMEMODE.CREATIVE;
  }

  /** Moves the hotbar cursor, wrapping, and plays the click. */
  selectSlot(i) {
    const n = HOTBAR_SIZE;
    const next = ((i % n) + n) % n;
    if (next === this.selectedSlot) return next;
    this.selectedSlot = next;
    this.cancelMining();
    if (this.usingItem) this.stopUsingItem();
    Game.emit('hotbarchange', next);
    return next;
  }

  /** Middle click: put the targeted block (or mob's spawn egg) in hand. */
  pickBlock() {
    const hit = this.hitResult;
    const creative = this.gameMode === GAMEMODE.CREATIVE;
    let name = null;
    if (hit.entity && hit.entity.type) {
      name = `${hit.entity.type}_spawn_egg`;
      if (!creative) return false;
    } else if (hit.block) {
      const def = getBlock(hit.block.blockId);
      name = def.itemName || def.name;
    }
    if (!name) return false;
    const ok = this.inventory.pickBlock(name, creative);
    if (ok) playAt('click', this.x, this.y, this.z, 0.3, 1.4);
    return ok;
  }

  /** Q / Ctrl+Q: throw the held item (or the whole stack) into the world. */
  dropSelected(whole = false) {
    const held = this.getHeldItem();
    if (isEmpty(held)) return null;
    let out;
    if (whole || held.count <= 1) {
      out = copyStack(held);
      this.inventory.set(this.selectedSlot, null);
    } else {
      out = copyStack(held);
      out.count = 1;
      held.count -= 1;
      this.inventory.set(this.selectedSlot, held);
    }
    return this.dropItem(out, true);
  }

  /** F: swap the main hand and the off hand. */
  swapOffhand() {
    const inv = this.inventory;
    if (!inv) return;
    const main = inv.getSelected();
    const off = inv.getOffhand();
    inv.set(inv.selected, off);
    inv.setOffhand(main);
    playAt('click', this.x, this.y, this.z, 0.25, 1.2);
  }

  // =========================================================================
  // Per-frame update
  // =========================================================================

  /**
   * @override movement, pose, mining progress and the camera, then the shared
   * entity physics.
   * @param {number} dt seconds since the previous frame
   */
  update(dt) {
    if (this.removed) return;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    if (!this.dead && !this.sleeping) this.applyMovementInput(dt);
    else { this.moveForward = 0; this.moveStrafe = 0; }

    this.updatePose();

    const px = this.x, pz = this.z;
    super.update(dt);

    this.hitResult = this.raycastTarget();

    if (!this.dead && !this.sleeping) {
      const travelled = Math.hypot(this.x - px, this.z - pz);
      this.trackDistance(travelled);
      this.mineTick(dt);
    } else {
      this.breakProgress = 0;
      this.breakTarget = null;
    }

    // A landing, a wall or letting go of forward all cancel a sprint.
    if (this.sprinting && (this.horizontalCollision || this.moveForward <= 0 || !this.canSprint())) {
      this.sprinting = false;
    }
    if (this.flying && this.onGround && this.gameMode !== GAMEMODE.SPECTATOR) this.flying = false;

    this.attackIndicator = this.getAttackStrength();

    this._installCameraFix();
    this._updateFov(dt);
  }

  /**
   * Turns the movement intent into velocity. Every state picks a target speed
   * and an acceleration; the acceleration is derived from the friction the
   * entity will apply this step, so the steady-state speed is exactly the
   * target no matter what the player is standing on.
   */
  applyMovementInput(dt) {
    const spectator = this.gameMode === GAMEMODE.SPECTATOR;
    this.noClip = spectator;

    let f = this.moveForward, s = this.moveStrafe;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }

    // Basis vectors in the vanilla convention.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fx = -sy, fz = cy;          // forward
    const sx = -cy, sz = -sy;         // right

    let dirX = fx * f + sx * s;
    let dirZ = fz * f + sz * s;
    const dirLen = Math.hypot(dirX, dirZ);
    if (dirLen > 1e-6) { dirX /= dirLen; dirZ /= dirLen; }

    const moving = dirLen > 1e-6;
    const effectSpeed = speedMultiplier(this);

    if (this.flying || spectator) {
      this.flyMove(dt, dirX, dirZ, moving, effectSpeed, spectator);
      return;
    }

    // --- climbing ---------------------------------------------------------
    if (this.onClimbable && !this.onGround) {
      const climb = this.climbSpeed || 2.35;
      if (this.jumping) this.vy = climb;
      else if (this.sneaking) this.vy = 0;
      else if (this.moveForward > 0) this.vy = climb * 0.85;
      else if (this.vy < -climb) this.vy = -climb;
      this.fallDistance = 0;
    }

    // --- target speed -----------------------------------------------------
    let target;
    if (this.inWater || this.inLava) {
      target = SWIM_SPEED * (this.sprinting ? 1.6 : 1);
      if (this.inLava) target *= 0.6;
      const boots = this.getEquipment(EQUIP.FEET);
      const depthStrider = clamp(getEnchant(boots, 'depth_strider') / 3, 0, 1);
      target *= 1 + depthStrider * 1.1;
    } else if (this.sneaking) {
      target = SNEAK_SPEED;
    } else if (this.sprinting) {
      target = SPRINT_SPEED;
    } else {
      target = WALK_SPEED;
    }
    if (this.moveForward < 0) target *= 0.75;      // walking backwards is slower
    else if (Math.abs(this.moveStrafe) > 0.5 && this.moveForward === 0) target *= 0.92;
    target *= effectSpeed;
    if (this.usingItem) target *= 0.25;            // eating / drawing a bow
    if (this.hasEffect('slowness') && target < 0.05) target = 0;

    // --- acceleration -----------------------------------------------------
    if (moving) {
      let accel;
      if (this.inWater || this.inLava) {
        accel = this.accelFor(target, this.inLava ? 0.5 : 0.8, dt);
      } else if (this.onGround) {
        const fr = clamp((this.groundFriction || 0.91) * (this.slipperiness || 0.6), 0.05, 0.999);
        accel = this.accelFor(target, fr, dt);
      } else {
        // Air control: a fifth of the ground authority, exactly like vanilla.
        accel = AIR_ACCEL * (this.sprinting ? 1.3 : 1) * clamp(target / WALK_SPEED, 0.3, 2);
      }
      this.vx += dirX * accel * dt;
      this.vz += dirZ * accel * dt;

      // Never let air steering push past the speed the state allows.
      if (!this.onGround && !this.inWater && !this.inLava) {
        const sp = Math.hypot(this.vx, this.vz);
        const cap = Math.max(target * 1.15, 0.001);
        if (sp > cap) { this.vx *= cap / sp; this.vz *= cap / sp; }
      }
    }

    // --- jumping ----------------------------------------------------------
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt * TICKS_PER_SECOND;
    if (this.jumping && this.jumpCooldown <= 0) {
      if (this.onGround && !this.onClimbable) this.jump();
      else if ((this.inWater || this.inLava) && !this.onGround) {
        // Buoyancy is handled in entity.physics via `jumping`.
        this.fallDistance = 0;
      }
    }

    // --- auto jump --------------------------------------------------------
    if (moving && this.onGround && this.jumpCooldown <= 0 && this.autoJumpEnabled()) {
      if (this.shouldAutoJump(dirX, dirZ)) this.jump();
    }

    // Swimming pose: sprint-swimming while submerged flattens the player out.
    this.swimming = this.inWater && this.submerged && (this.sprinting || this.moveForward > 0) &&
      !this.onGround;
  }

  /**
   * Acceleration (blocks/s^2) that settles at exactly `target` blocks/s given a
   * per-tick friction of `f`.
   *
   * entity.physics() moves by the velocity *before* friction and then scales it
   * by f^(20*dt), so the speed converges on `a * dt / (1 - f^(20*dt))`. Solving
   * that for `a` is exact at any frame rate, which is why a 30 Hz and a 144 Hz
   * frame walk at the same 4.317 blocks a second.
   */
  accelFor(target, f, dt) {
    if (!(dt > 0)) return 0;
    const decay = 1 - Math.pow(clamp(f, 0.01, 0.999), TICKS_PER_SECOND * dt);
    return target * decay / dt;
  }

  /** Creative / spectator flight: velocity is assigned, not accumulated. */
  flyMove(dt, dirX, dirZ, moving, effectSpeed, spectator) {
    const base = (spectator ? FLY_SPEED * 1.3 : FLY_SPEED) * this.flySpeedMul *
      (this.sprinting ? 2 : 1) * effectSpeed;
    const targetX = moving ? dirX * base : 0;
    const targetZ = moving ? dirZ * base : 0;

    let targetY = 0;
    if (this.jumping) targetY += base * 0.65;
    if (this.sneaking) targetY -= base * 0.65;

    // Smooth but quick: full speed in about a tenth of a second.
    const k = Math.min(1, dt * 12);
    this.vx += (targetX - this.vx) * k;
    this.vz += (targetZ - this.vz) * k;
    this.vy += (targetY - this.vy) * k;
    this.fallDistance = 0;
    this.swimming = false;
  }

  /** True when the auto-jump option is on. */
  autoJumpEnabled() {
    try {
      const v = Game.settings && Game.settings.get('autoJump');
      return v === undefined ? false : !!v;
    } catch { return false; }
  }

  /**
   * The classic auto-jump probe: a solid block one step ahead at foot level
   * with two free blocks above it.
   */
  shouldAutoJump(dirX, dirZ) {
    const world = this.world;
    if (!world) return false;
    const ahead = this.width * 0.5 + 0.35;
    const x = Math.floor(this.x + dirX * ahead);
    const z = Math.floor(this.z + dirZ * ahead);
    const y = Math.floor(this.y + 0.05);
    if (!world.isSolid(x, y, z)) return false;
    if (world.isSolid(x, y + 1, z) || world.isSolid(x, y + 2, z)) return false;
    // Do not hop up something the step-height already handles.
    const boxes = world.getCollisionBoxes
      ? world.getCollisionBoxes(_scratchBox.set(x, y, z, x + 1, y + 1, z + 1), [])
      : null;
    if (boxes && boxes.length) {
      let top = 0;
      for (let i = 0; i < boxes.length; i++) top = Math.max(top, boxes[i].y1);
      if (top - this.y <= this.stepHeight + 1e-3) return false;
    }
    return true;
  }

  /** Launches a jump, with jump boost, the sprint impulse and exhaustion. */
  jump() {
    if (!this.onGround || this.dead) return;
    let v = JUMP_VELOCITY * JUMP_DRAG_COMPENSATION * jumpMultiplier(this);
    const below = getBlock(this.blockBelowId());
    if (below && below.name === 'honey_block') v *= 0.5;
    this.vy = v;
    if (this.sprinting) {
      const fx = -Math.sin(this.yaw), fz = Math.cos(this.yaw);
      this.vx += fx * SPRINT_JUMP_BOOST;
      this.vz += fz * SPRINT_JUMP_BOOST;
    }
    this.onGround = false;
    this.jumpCooldown = JUMP_DELAY;
    this.stats.jumps++;
    this.addExhaustion(this.sprinting ? EXH_SPRINT_JUMP : EXH_JUMP);
  }

  /** Sneaking, swimming and sleeping shrink the hitbox and drop the camera. */
  updatePose() {
    let h = PLAYER_HEIGHT, eye = PLAYER_EYE;
    if (this.sleeping) { h = 0.6; eye = 0.4; }
    else if (this.swimming || this.crawling) { h = 0.6; eye = 0.4; }
    else if (this.sneaking) { h = SNEAK_HEIGHT; eye = PLAYER_EYE_SNEAK; }

    if (h > this.height && !this.hasHeadroom(h)) return;   // stuck under a slab
    this.height = h;
    this.eyeHeight = eye;
  }

  /** True when the player would fit if they stood up to `h` blocks tall. */
  hasHeadroom(h) {
    const world = this.world;
    if (!world || typeof world.getCollisionBoxes !== 'function') return true;
    const hw = this.width * 0.5 - 0.001;
    _scratchBox.set(this.x - hw, this.y + this.height, this.z - hw,
      this.x + hw, this.y + h - 0.001, this.z + hw);
    if (_scratchBox.y1 <= _scratchBox.y0) return true;
    const boxes = world.getCollisionBoxes(_scratchBox, []);
    for (let i = 0; i < boxes.length; i++) if (boxes[i].intersects(_scratchBox)) return false;
    return true;
  }

  /** Footstep sounds and the sprint/swim exhaustion, both driven by distance. */
  trackDistance(travelled) {
    if (travelled <= 0) return;
    this.stats.distance += travelled;

    if (this.inWater) this.addExhaustion(EXH_SWIM_PER_BLOCK * travelled);
    else if (this.sprinting && this.onGround) this.addExhaustion(EXH_SPRINT_PER_BLOCK * travelled);

    if (this.flying || this.gameMode === GAMEMODE.SPECTATOR) return;

    this.walkDistance += travelled;
    if (this.walkDistance < this.nextStepDistance) return;
    this.nextStepDistance = this.walkDistance + (this.sprinting ? STEP_DISTANCE * 0.75 : STEP_DISTANCE);

    if (this.inWater) {
      playAt('swim', this.x, this.y, this.z, 0.25, 0.9 + Math.random() * 0.2);
      return;
    }
    if (!this.onGround) return;
    const below = getBlock(this.blockBelowId());
    if (!below || below.id === 0) return;
    const vol = this.sneaking ? 0.08 : 0.16;
    playAt('step_' + soundGroup(below), this.x, this.y, this.z, vol, 0.9 + Math.random() * 0.2);
  }

  // =========================================================================
  // 20 Hz tick
  // =========================================================================

  /** @override adds hunger, regeneration, item use timers and sleeping. */
  tick() {
    if (this.removed) return;
    super.tick();
    if (this.removed) return;

    // Attack speed follows the item in hand, scaled by haste / mining fatigue.
    const held = this.getHeldItem();
    const tool = toolOf(held);
    this.attackSpeed = (tool && tool.attackSpeed ? tool.attackSpeed : 4) * attackSpeedMultiplier(this);

    // Health boost / absorption change the ceiling.
    const bonus = maxHealthBonus(this);
    this.maxHealth = MAX_HEALTH + (bonus > 0 ? bonus : 0);
    if (this.health > this.maxHealth) this.health = this.maxHealth;

    if (this.breakCooldown > 0) this.breakCooldown--;
    if (this.useCooldown > 0) this.useCooldown--;
    if (this.xpCooldown > 0) this.xpCooldown--;
    if (this.itemCooldowns.size) {
      for (const [k, v] of this.itemCooldowns) {
        if (v <= 1) this.itemCooldowns.delete(k);
        else this.itemCooldowns.set(k, v - 1);
      }
    }

    this.tickUsingItem();
    if (!this.dead) this.tickHunger();
    this.tickSleep();

    if (this.dead) { this.breakProgress = 0; this.breakTarget = null; }
  }

  /** Advances the charge-up / eating animation and fires the finish hook. */
  tickUsingItem() {
    if (!this.usingItem) { this.useTicks = 0; return; }
    const stack = this.usingItem;
    if (isEmpty(stack)) { this.usingItem = null; this.useTicks = 0; return; }
    this.useTicks++;

    const def = getItem(stack.item);
    if (def.useAction === 'eat' || def.useAction === 'drink') {
      if ((this.useTicks % 4) === 0) {
        playAt(def.useAction === 'drink' ? 'drink' : 'eat',
          this.x, this.y + this.eyeHeight, this.z, 0.5, 0.9 + Math.random() * 0.2);
        particles('block', this.x, this.y + this.eyeHeight - 0.15, this.z,
          { count: 3, spread: 0.25, blockId: 0, color: def.color || 0xbb9977 });
      }
    }
    const dur = this.useDuration || def.useDuration || 32;
    if (dur > 0 && this.useTicks >= dur) this.finishUsingItem();
  }

  /** Hunger drain, saturation regeneration and starvation damage. */
  tickHunger() {
    const peaceful = Game.difficulty === DIFFICULTY.PEACEFUL;
    const survival = this.gameMode === GAMEMODE.SURVIVAL || this.gameMode === GAMEMODE.ADVENTURE;

    if (survival && !peaceful) {
      if (this.exhaustion > 4) {
        this.exhaustion -= 4;
        if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
        else this.hunger = Math.max(0, this.hunger - 1);
      }
    } else if (peaceful) {
      // Peaceful tops the food bar back up on its own.
      this.exhaustion = 0;
      if ((this.age % 20) === 0 && this.hunger < MAX_HUNGER) this.hunger++;
    }

    const hurtable = this.health < this.maxHealth && !this.dead;

    // Saturation regen: fast healing while the bar is full and saturated.
    if (hurtable && this.hunger >= 18 && this.saturation > 0 && survival) {
      this.regenTimer++;
      if (this.regenTimer >= REGEN_FAST_TICKS) {
        this.regenTimer = 0;
        const healed = Math.min(this.saturation, 1);
        this.heal(healed);
        this.addExhaustion(healed * EXH_REGEN);
      }
    } else if (hurtable && (this.hunger >= 18 || peaceful || !survival)) {
      this.regenTimer++;
      const period = peaceful ? REGEN_SLOW_TICKS / 2 : REGEN_SLOW_TICKS;
      if (this.regenTimer >= period) {
        this.regenTimer = 0;
        this.heal(1);
        if (survival) this.addExhaustion(EXH_REGEN);
      }
    } else {
      this.regenTimer = 0;
    }

    // Starvation, gated by difficulty exactly like vanilla.
    if (survival && this.hunger <= 0 && !peaceful) {
      this.starveTimer++;
      if (this.starveTimer >= STARVE_TICKS) {
        this.starveTimer = 0;
        const d = Game.difficulty;
        const floor = d === DIFFICULTY.EASY ? 10 : d === DIFFICULTY.NORMAL ? 1 : 0;
        if (this.health > floor) {
          this.hurt(1, source('starve', null, { bypassArmor: true, bypassCooldown: true }));
        }
      }
    } else {
      this.starveTimer = 0;
    }

    if (this.hunger <= 6) this.sprinting = false;
  }

  /** Counts a night down and skips it once everyone is asleep. */
  tickSleep() {
    if (!this.sleeping) return;
    const world = this.world;
    this.sleepTicks++;
    this.vx = 0; this.vz = 0;
    if (!world) { this.wakeUp(true); return; }
    if (this.sleepTicks < SLEEP_TICKS) return;

    if (typeof world.isNight === 'function' && world.isNight()) {
      world.time = 0;                       // sunrise
      if (world.weather) {
        world.weather.rain = 0;
        world.weather.thunder = 0;
        world.weather.rainTicks = 0;
        world.weather.thunderTicks = 0;
      }
      Game.log('Good morning.');
    }
    this.wakeUp(false);
  }

  // =========================================================================
  // Targeting
  // =========================================================================

  /**
   * What the crosshair is on: the first block along the look ray and the
   * closest entity in front of it.
   * @returns {{block: object|null, entity: object|null}}
   */
  raycastTarget() {
    const out = { block: null, entity: null };
    const world = this.world;
    if (!world) return out;
    const d = this.getLookVec(_lookVec);
    const ox = this.x, oy = this.y + this.eyeHeight, oz = this.z;
    const reach = this.getReach();

    try {
      out.block = world.raycast(ox, oy, oz, d.x, d.y, d.z, reach, { fluids: false }) || null;
    } catch { out.block = null; }

    if (this.gameMode === GAMEMODE.SPECTATOR) return out;

    const eReach = Math.min(this.getAttackReach(), out.block ? out.block.distance : reach);
    if (eReach > 0.1 && typeof world.raycastEntity === 'function') {
      try {
        const hit = world.raycastEntity(ox, oy, oz, d.x, d.y, d.z, eReach, (e) => (
          e && e !== this && !e.removed && !e.dead && !NON_TARGET_TYPES.has(e.type)
        ));
        if (hit && hit.entity) out.entity = hit.entity;
      } catch { /* optional */ }
    }
    return out;
  }

  // =========================================================================
  // Mining
  // =========================================================================

  /**
   * Accumulates breaking progress against whatever the crosshair is on.
   *
   * speed  = tool speed (efficiency adds level^2 + 1) * haste / mining fatigue,
   *          divided by 5 when swimming without aqua affinity and again when
   *          airborne;
   * damage = speed / hardness / 30, or / 100 when the tool cannot harvest it.
   * @param {number} dt seconds since the previous frame
   */
  mineTick(dt) {
    const world = this.world;
    if (!world || this.gameMode === GAMEMODE.SPECTATOR) { this.cancelMining(); return; }
    if (!this.mining) { this.cancelMining(); return; }

    const hit = this.hitResult && this.hitResult.block;
    if (!hit) { this.cancelMining(); return; }

    const id = hit.blockId;
    const def = getBlock(id);
    if (!def || def.id === 0) { this.cancelMining(); return; }

    // A new block always restarts the progress bar.
    const t = this.breakTarget;
    if (!t || t.x !== hit.x || t.y !== hit.y || t.z !== hit.z) {
      this.breakTarget = { x: hit.x, y: hit.y, z: hit.z, id, meta: hit.meta };
      this.breakProgress = 0;
      this.breakDamageTicks = 0;
    } else {
      t.id = id; t.meta = hit.meta;
    }

    this.swingArm();
    const heldItem = Game.heldItem;
    if (heldItem && typeof heldItem.swing === 'function' && (this.age % 6) === 0) {
      try { heldItem.swing(); } catch { /* optional */ }
    }

    if (this.gameMode === GAMEMODE.CREATIVE) {
      if (def.hardness < 0) { this.breakProgress = 0; return; }
      if (this.breakCooldown > 0) return;
      this.breakCooldown = CREATIVE_BREAK_DELAY;
      this.breakProgress = 0;
      this.breakBlock(hit.x, hit.y, hit.z);
      return;
    }

    if (def.hardness < 0) { this.breakProgress = 0; return; }   // bedrock & friends

    const ticks = dt * TICKS_PER_SECOND;
    const perTick = this.blockDamagePerTick(def);
    if (perTick <= 0) { this.breakProgress = 0; return; }

    this.breakProgress = clamp(this.breakProgress + perTick * ticks, 0, 1);
    this.breakDamageTicks += ticks;

    // Chips, dust and the dig sound go out on a fixed cadence, not per frame.
    if (this.breakDamageTicks >= DIG_SOUND_INTERVAL) {
      this.breakDamageTicks -= DIG_SOUND_INTERVAL;
      const p = Game.particles;
      if (p && typeof p.blockHit === 'function') {
        try { p.blockHit(hit.x, hit.y, hit.z, id, hit.face); } catch { /* optional */ }
      }
      playAt('dig_' + soundGroup(def), hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.22, 0.5);
    }

    Game.emit('breakprogress', hit.x, hit.y, hit.z, this.breakProgress, id);

    if (this.breakProgress >= 1) {
      this.breakProgress = 0;
      this.breakDamageTicks = 0;
      this.breakCooldown = 1;
      this.breakBlock(hit.x, hit.y, hit.z);
      this.breakTarget = null;
    }
  }

  /** Fraction of a block broken per tick against `def` with the current tool. */
  blockDamagePerTick(def) {
    const hardness = def.hardness;
    if (hardness < 0) return 0;
    if (hardness === 0) return 1;

    const stack = this.getHeldItem();
    const tool = toolOf(stack);
    let speed = 1;
    const kind = tool ? tool.kind : null;
    if (kind && def.tool && kind === def.tool) {
      speed = tool.speed || 1;
    } else if (kind === 'sword') {
      // Swords cut plants twice as fast and shred cobwebs.
      speed = def.name === 'cobweb' ? 15 : (def.model === 'cross' || def.model === 'crop') ? 1.5 : 1;
    } else if (kind === 'shears') {
      if (def.name.endsWith('_wool') || def.name.endsWith('_carpet')) speed = 5;
      else if (def.name === 'cobweb' || def.name.endsWith('_leaves') || def.model === 'cross') speed = 15;
    }

    if (speed > 1) {
      const eff = getEnchant(stack, 'efficiency');
      if (eff > 0) speed += eff * eff + 1;
    }
    speed *= miningSpeedMultiplier(this);

    // Swimming without aqua affinity, and mining in mid-air, are both 5x slower.
    if (this.submerged && getEnchant(this.getEquipment(EQUIP.HEAD), 'aqua_affinity') <= 0) speed /= 5;
    if (!this.onGround) speed /= 5;

    const harvest = canHarvest(def, stack);
    return speed / hardness / (harvest ? 30 : 100);
  }

  /** Forgets any partial progress (target changed, button released, ...). */
  cancelMining() {
    if (this.breakTarget || this.breakProgress) {
      Game.emit('breakprogress', 0, 0, 0, 0, 0);
    }
    this.breakTarget = null;
    this.breakProgress = 0;
    this.breakDamageTicks = 0;
  }

  /**
   * Removes a block: drops, XP, particles, sound, neighbour updates and tool
   * wear. Safe to call for any position.
   */
  breakBlock(x, y, z) {
    const world = this.world;
    if (!world) return false;
    const raw = world.getRaw(x, y, z);
    const id = raw & 0x0fff;
    if (id === 0) return false;
    const meta = (raw >>> 12) & 15;
    const def = getBlock(id);
    if (def.hardness < 0 && this.gameMode !== GAMEMODE.CREATIVE) return false;

    const stack = this.getHeldItem();
    const creative = this.gameMode === GAMEMODE.CREATIVE;

    // Drops first, while the block is still there for the loot context.
    if (!creative && (!world.gameRules || world.gameRules.doTileDrops !== false)) {
      let stacks = null;
      try { stacks = blockDrops(world, x, y, z, id, meta, stack, this); } catch (e) {
        console.error('[player] blockDrops failed', e);
      }
      if (stacks) for (let i = 0; i < stacks.length; i++) this.spawnDropAt(x + 0.5, y + 0.5, z + 0.5, stacks[i]);

      let xp = 0;
      try { xp = blockXP(id, stack) | 0; } catch { xp = 0; }
      if (xp > 0) this.spawnXPAt(x + 0.5, y + 0.5, z + 0.5, xp);
    }

    // Particles and sound before the world forgets what was there.
    const p = Game.particles;
    if (p && typeof p.blockBreak === 'function') {
      try { p.blockBreak(x, y, z, id); } catch { /* optional */ }
    }
    playAt('dig_' + soundGroup(def), x + 0.5, y + 0.5, z + 0.5, 0.8, 0.85 + Math.random() * 0.2);

    world.setBlock(x, y, z, 0, 0, 3);
    this.breakLinkedParts(x, y, z, id, meta, def);

    if (_blockupdate && typeof _blockupdate.onBlockBroken === 'function') {
      try { _blockupdate.onBlockBroken(world, x, y, z, id, meta, this); } catch (e) {
        console.error('[player] onBlockBroken failed', e);
      }
    }

    // Tool wear and the item hook.
    if (!creative && !isEmpty(stack)) {
      const itemDef = getItem(stack.item);
      try { itemDef.onBreakBlock(world, this, stack, x, y, z); } catch { /* optional */ }
      if (def.hardness > 0 && itemDef.durability) damageStack(stack, 1, this);
    }

    this.addExhaustion(EXH_MINE);
    this.stats.blocksMined++;
    Game.emit('blockbreak', x, y, z, id, this);
    return true;
  }

  /**
   * Removes the second half of a two-block structure: door halves, bed halves
   * and the tops of tall plants.
   */
  breakLinkedParts(x, y, z, id, meta, def) {
    const world = this.world;
    if (!world) return;
    if (def.model === 'door') {
      const otherY = (meta & 1) ? y - 1 : y + 1;
      if (world.getBlock(x, otherY, z) === id) world.setBlock(x, otherY, z, 0, 0, 3);
      return;
    }
    if (def.model === 'bed') {
      const facing = meta & 3;
      const head = (meta & 4) !== 0;
      const d = HFACE_DIRS[facing] || [0, 0, 0];
      const ox = head ? x - d[0] : x + d[0];
      const oz = head ? z - d[2] : z + d[2];
      if (world.getBlock(ox, y, oz) === id) world.setBlock(ox, y, oz, 0, 0, 3);
      return;
    }
    // Sunflowers, lilacs and friends: the upper half cannot float.
    if (def.model === 'cross' && world.getBlock(x, y + 1, z) === id) {
      world.setBlock(x, y + 1, z, 0, 0, 3);
    }
  }

  // =========================================================================
  // Using items / placing blocks
  // =========================================================================

  /**
   * Right click. Tries, in order: interacting with the targeted entity, the
   * block's own use behaviour, the held item's block hook, placing the item's
   * block, and finally the item's generic use hook.
   * @returns {boolean} true when something consumed the click
   */
  useItem() {
    if (this.dead || this.gameMode === GAMEMODE.SPECTATOR) return false;
    const world = this.world;
    if (!world) return false;

    const target = this.hitResult && (this.hitResult.block || this.hitResult.entity)
      ? this.hitResult : this.raycastTarget();
    let stack = this.getHeldItem();
    let hand = 'mainhand';
    if (isEmpty(stack)) {
      const off = this.getOffhandItem();
      if (!isEmpty(off)) { stack = off; hand = 'offhand'; }
    }
    this.usingHand = hand;
    this.useCooldown = PLACE_DELAY;

    // 1. entities
    if (target.entity) {
      if (this.interactWithEntity(target.entity, stack, hand)) {
        this.swingArm();
        return true;
      }
    }

    const itemDef = isEmpty(stack) ? null : getItem(stack.item);
    const hit = target.block;

    if (hit) {
      const holdingBlock = !!(itemDef && itemDef.block);
      // 2. the block's own right-click behaviour, unless the player is sneaking
      //    with something to place.
      if (!(this.sneaking && holdingBlock)) {
        if (this.useBlockAt(hit, stack, hand)) { this.swingArm(); return true; }
      }
      // 3. the item's block hook (hoe, flint & steel, bone meal, buckets, ...)
      if (itemDef) {
        let used = false;
        try { used = !!itemDef.onUseOnBlock(world, this, stack, hit); } catch (e) {
          console.error('[player] onUseOnBlock failed', stack && stack.item, e);
        }
        if (used) { this.swingArm(); return true; }
      }
      // 4. place the block
      if (holdingBlock && this.placeBlock(hit, stack)) { this.swingArm(); return true; }
    }

    // 5. the generic use hook (bows, food, potions, throwables, spyglass)
    if (itemDef) {
      if (this.hasItemCooldown(stack.item)) return false;
      // Items that start a charge-up set `usingItem`/`useDuration` themselves;
      // clear the old duration first so a stale one cannot leak into it.
      this.useDuration = 0;
      let used = false;
      try { used = !!itemDef.onUse(world, this, stack, hit || null); } catch (e) {
        console.error('[player] onUse failed', stack && stack.item, e);
      }
      if (used) {
        if (stack.item === 'ender_pearl' || stack.item === 'chorus_fruit') {
          this.setItemCooldown(stack.item, 20);
        }
        // Items that started a charge-up parked themselves on `usingItem`.
        if (this.usingItem) {
          this.useDuration = this.useDuration || getItem(this.usingItem.item).useDuration || 32;
        } else {
          this.swingArm();
        }
        return true;
      }
    }
    return false;
  }

  /** Right-clicking a mob: taming, breeding, shearing, trading, riding. */
  interactWithEntity(entity, stack, hand) {
    if (!entity) return false;
    if (typeof entity.interact === 'function') {
      try { if (entity.interact(this, stack, hand)) return true; } catch (e) {
        console.error('[player] entity interact failed', entity.type, e);
      }
    }
    if (!isEmpty(stack)) {
      const def = getItem(stack.item);
      try { if (def.onUseOnEntity(this.world, this, stack, entity)) return true; } catch { /* optional */ }
    }
    return false;
  }

  /**
   * The block's own right-click behaviour. blockupdate.js owns this; the
   * fallback here keeps doors, gates and containers usable while that module
   * is still being written.
   */
  useBlockAt(hit, stack, hand) {
    const world = this.world;
    if (!world) return false;
    if (_blockupdate && typeof _blockupdate.useBlock === 'function') {
      try {
        if (_blockupdate.useBlock(world, hit.x, hit.y, hit.z, this, hand, hit.face,
          hit.px - hit.x, hit.py - hit.y, hit.pz - hit.z)) return true;
      } catch (e) { console.error('[player] useBlock failed', e); }
    }
    return this.fallbackUseBlock(hit);
  }

  /** Minimal built-in block interactions: doors, gates, trapdoors, screens, beds. */
  fallbackUseBlock(hit) {
    const world = this.world;
    const id = world.getBlock(hit.x, hit.y, hit.z);
    if (id === 0) return false;
    const def = getBlock(id);
    const meta = world.getMeta(hit.x, hit.y, hit.z);

    if (def.model === 'door') {
      // Iron doors only move for redstone.
      if (def.name.indexOf('iron') === 0) return false;
      const open = (meta & 8) !== 0;
      const upper = (meta & 1) !== 0;
      const baseY = upper ? hit.y - 1 : hit.y;
      for (let i = 0; i < 2; i++) {
        const y = baseY + i;
        if (world.getBlock(hit.x, y, hit.z) !== id) continue;
        const m = world.getMeta(hit.x, y, hit.z);
        world.setBlock(hit.x, y, hit.z, id, open ? (m & ~8) : (m | 8), 3);
      }
      playAt(open ? 'door_close' : 'door_open', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.9, 1);
      return true;
    }
    if (def.model === 'trapdoor' || def.model === 'fence_gate') {
      if (def.name.indexOf('iron') === 0) return false;
      const open = (meta & 4) !== 0;
      world.setBlock(hit.x, hit.y, hit.z, id, open ? (meta & ~4) : (meta | 4), 3);
      playAt(open ? 'door_close' : 'door_open', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.8, 1.1);
      return true;
    }
    if (def.model === 'bed') return this.sleepIn(hit.x, hit.y, hit.z);

    const screen = SCREEN_FOR_BLOCK[def.name] ||
      (def.name.endsWith('_shulker_box') ? 'chest' : null);
    if (screen) {
      const ui = Game.ui;
      if (ui && ui.screens && typeof ui.screens.open === 'function') {
        try {
          ui.screens.open(screen, { x: hit.x, y: hit.y, z: hit.z, player: this, block: def.name });
          if (screen === 'chest') playAt('chest_open', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.7, 1);
          return true;
        } catch (e) { console.error('[player] open screen failed', screen, e); }
      }
    }
    return false;
  }

  /**
   * Places the block a held item maps to. Validates the space, the neighbours
   * and that no entity is standing there, then computes the metadata from the
   * face that was clicked and the direction the player is looking.
   * @returns {boolean} true when a block was placed
   */
  placeBlock(hit, stack) {
    const world = this.world;
    if (!world || isEmpty(stack)) return false;
    const itemDef = getItem(stack.item);
    const blockDef = blockByName(itemDef.block);
    if (!blockDef) return false;

    // Clicking a replaceable block (tall grass, snow, water) fills it in place.
    const hitDef = getBlock(world.getBlock(hit.x, hit.y, hit.z));
    let x = hit.x, y = hit.y, z = hit.z;
    if (!hitDef.replaceable) {
      const d = FACE_DIRS[hit.face] || [0, 1, 0];
      x += d[0]; y += d[1]; z += d[2];
    }
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    if (!replaceableAt(world, x, y, z)) return false;

    // Snow layers and similar stack up instead of replacing.
    let meta = this.placementMeta(blockDef, hit, x, y, z);
    if (meta < 0) return false;

    if (blockDef.solid && blockDef.collision !== 'none' && this.blockedByEntity(blockDef, meta, x, y, z)) {
      return false;
    }

    // Two-block structures need their second half before anything is written.
    const extra = this.secondHalfFor(blockDef, meta, x, y, z);
    if (extra === false) return false;

    world.setBlock(x, y, z, blockDef.id, meta, 3);
    if (extra) world.setBlock(extra.x, extra.y, extra.z, blockDef.id, extra.meta, 3);

    playAt('place_' + soundGroup(blockDef), x + 0.5, y + 0.5, z + 0.5, 0.8, 0.9 + Math.random() * 0.2);

    if (_blockupdate && typeof _blockupdate.onBlockPlaced === 'function') {
      try { _blockupdate.onBlockPlaced(world, x, y, z, blockDef.id, meta, this); } catch (e) {
        console.error('[player] onBlockPlaced failed', e);
      }
    }

    if (this.gameMode !== GAMEMODE.CREATIVE) {
      stack.count -= 1;
      if (stack.count <= 0) this.clearStack(stack);
      else this.inventory.markChanged(-1);
    }
    this.stats.blocksPlaced++;
    Game.emit('blockplace', x, y, z, blockDef.id, this);
    return true;
  }

  /** True when a living entity (or the player) is standing where a block goes. */
  blockedByEntity(def, meta, x, y, z) {
    const world = this.world;
    if (!world || typeof world.entitiesInAABB !== 'function') return false;
    _scratchBox.set(x, y, z, x + 1, y + 1, z + 1);
    if (def.collision === 'half') _scratchBox.y1 = y + ((meta & 1) ? 1 : 0.5);
    let list = [];
    try {
      list = world.entitiesInAABB(_scratchBox, (e) => (
        e && !e.removed && !NON_TARGET_TYPES.has(e.type) && e.noClip !== true
      ));
    } catch { return false; }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead && !e.isPlayer) continue;
      const box = e.aabb(new AABB());
      if (box.intersects(_scratchBox)) return true;
    }
    return false;
  }

  /**
   * The second block a door or bed needs.
   * @returns {null|false|{x:number,y:number,z:number,meta:number}} false when
   *          there is no room, null when the block is a single cube.
   */
  secondHalfFor(def, meta, x, y, z) {
    const world = this.world;
    if (def.model === 'door') {
      if (!replaceableAt(world, x, y + 1, z)) return false;
      return { x, y: y + 1, z, meta: meta | 1 };
    }
    if (def.model === 'bed') {
      const d = HFACE_DIRS[meta & 3] || [0, 0, 0];
      const hx = x + d[0], hz = z + d[2];
      if (!replaceableAt(world, hx, y, hz)) return false;
      if (!world.isSolid(hx, y - 1, hz)) return false;
      return { x: hx, y, z: hz, meta: (meta & 3) | 4 };
    }
    return null;
  }

  /**
   * Metadata for a freshly placed block: slab halves, stair orientation, log
   * axis, torch and ladder mounting, door/bed/chest facing and snow depth.
   * @returns {number} the metadata, or -1 when the block cannot go there
   */
  placementMeta(def, hit, x, y, z) {
    const world = this.world;
    const face = hit.face;
    const hf = this.horizontalFacing();
    const opposite = (hf + 2) & 3;
    const fracY = hit.py - Math.floor(hit.py);
    const topHalf = face === FACE_DOWN || (face !== FACE_UP && fracY > 0.5);

    switch (def.model) {
      case 'slab':
        return topHalf ? 1 : 0;

      case 'stairs': {
        // The mesher puts the tall half opposite the stored facing, and vanilla
        // puts it in front of the player, so the stored facing is reversed.
        let m = opposite & 3;
        if (topHalf) m |= 4;
        return m;
      }

      case 'column':
        return face === FACE_UP || face === FACE_DOWN ? 0 : (face === 4 || face === 5 ? 1 : 2);

      case 'end_rod':
        return face === FACE_UP || face === FACE_DOWN ? 0 : (face === 4 || face === 5 ? 1 : 2);

      case 'torch': {
        if (face === FACE_UP) return 0;
        if (face === FACE_DOWN) return -1;
        const h = FACE_TO_HFACE[face];
        return h < 0 ? 0 : h + 1;
      }

      case 'ladder': {
        const h = FACE_TO_HFACE[face];
        if (h < 0) return -1;                 // ladders need a wall
        return h;
      }

      case 'wall_sign': {
        const h = FACE_TO_HFACE[face];
        if (h < 0) return -1;
        return (h + 2) & 3;                   // the plate hugs the wall behind it
      }

      case 'sign':
        return face === FACE_UP ? (hf & 3) : -1;

      case 'door':
        return (hf & 3) << 1;

      case 'trapdoor': {
        let m = opposite & 3;
        if (topHalf) m |= 8;
        return m;
      }

      case 'fence_gate':
        return hf & 3;

      case 'bed':
        return hf & 3;

      case 'chest':
        return opposite & 3;

      case 'button':
      case 'lever': {
        if (face === FACE_UP) return 0;
        if (face === FACE_DOWN) return 5;
        const h = FACE_TO_HFACE[face];
        return h < 0 ? 0 : h + 1;
      }

      case 'layer': {
        const cur = world.getBlock(x, y, z);
        if (cur === def.id) return Math.min(7, (world.getMeta(x, y, z) & 7) + 1);
        return 0;
      }

      case 'piston': {
        // Pistons store a 6-way FACE index, not the 4-way horizontal facing the
        // other front-faced machines use: redstone.js and the mesher both read
        // `meta & 7` as a FACE, and worldgen already writes it that way. Falling
        // through to the generic front-face branch below gave every placed
        // piston a head on the wrong side. Bit 3 stays clear for "extended".
        if (this.pitch < -Math.PI / 3) return FACE_UP;
        if (this.pitch > Math.PI / 3) return FACE_DOWN;
        return HFACE_TO_FACE[hf];
      }

      case 'crop':
      case 'cross':
      case 'flat':
      case 'carpet':
      case 'rail':
        return 0;

      default:
        break;
    }

    // Machines with a distinct front face point it back at the player.
    if (def.tex && typeof def.tex === 'object' && def.tex.front !== undefined) return opposite & 3;
    if (def.model === 'anvil' || def.model === 'hopper') return opposite & 3;
    return 0;
  }

  /** Removes an exact stack object from wherever it sits in the inventory. */
  clearStack(stack) {
    const inv = this.inventory;
    if (!inv || !stack) return;
    for (let i = 0; i < inv.size; i++) {
      if (inv.get(i) === stack) { inv.set(i, null); return; }
    }
    if (inv.getSelected() === stack) inv.set(inv.selected, null);
  }

  // ---- charge-up items ---------------------------------------------------

  /** Releases a charged item (bow, trident, shield, spyglass). */
  stopUsingItem() {
    const stack = this.usingItem;
    const ticks = this.useTicks;
    this.usingItem = null;
    this.useTicks = 0;
    this.useDuration = 0;
    if (isEmpty(stack)) return;
    const def = getItem(stack.item);
    try { def.onStopUsing(this.world, this, stack, ticks); } catch (e) {
      console.error('[player] onStopUsing failed', stack.item, e);
    }
  }

  /** The charge finished on its own (food eaten, crossbow loaded). */
  finishUsingItem() {
    const stack = this.usingItem;
    this.usingItem = null;
    this.useTicks = 0;
    this.useDuration = 0;
    if (isEmpty(stack)) return;
    const def = getItem(stack.item);
    try { def.onFinishUsing(this.world, this, stack); } catch (e) {
      console.error('[player] onFinishUsing failed', stack.item, e);
    }
  }

  /**
   * Applies a food item's nutrition. The item module consumes the stack when
   * this leaves the count alone, so nothing is eaten twice.
   */
  eat(stack) {
    if (isEmpty(stack)) return false;
    const def = getItem(stack.item);
    const food = def.food;
    if (!food) return false;
    this.hunger = clamp(this.hunger + (food.hunger || 0), 0, MAX_HUNGER);
    // items.js stores the absolute saturation a food restores (bread = 6.0),
    // not vanilla's saturation *modifier*, so it is added straight on.
    this.saturation = clamp(this.saturation + (food.saturation || 0), 0, this.hunger);
    playAt('burp', this.x, this.y + this.eyeHeight, this.z, 0.4, 0.9 + Math.random() * 0.2);
    return true;
  }

  // =========================================================================
  // Combat
  // =========================================================================

  /** Base melee damage: fist or weapon, plus the strength effect. */
  getAttackDamage() {
    const stack = this.getHeldItem();
    const tool = toolOf(stack);
    let dmg = 1;
    if (tool && tool.damage) dmg = tool.damage;
    dmg += attackDamageBonus(this);
    return Math.max(0, dmg);
  }

  /**
   * Swings at an entity with the 1.9+ cooldown curve: a full-charge hit does
   * the listed damage, an uncharged one as little as 20% of it.
   */
  attack(entity) {
    if (!entity || this.dead || entity === this) return false;
    if (this.gameMode === GAMEMODE.SPECTATOR || this.gameMode === GAMEMODE.ADVENTURE) return false;
    if (typeof entity.hurt !== 'function') return false;

    const stack = this.getHeldItem();
    const strength = this.getAttackStrength();
    this.resetAttackCooldown();
    this.swingArm();
    const heldView = Game.heldItem;
    if (heldView && typeof heldView.swing === 'function') {
      try { heldView.swing(); } catch { /* optional */ }
    }

    let damage = this.getAttackDamage();
    let enchBonus = 0;
    try { enchBonus = bonusDamage(stack, entity); } catch { enchBonus = 0; }

    // The charge curve: 0.2 + 0.8 * t^2 of the listed damage.
    const charge = 0.2 + strength * strength * 0.8;
    damage *= charge;
    enchBonus *= charge;

    // Critical hit: falling, not sprinting, not climbing or swimming.
    const crit = strength > 0.9 && !this.onGround && this.vy < 0 && !this.onClimbable &&
      !this.inWater && !this.sprinting && !this.hasEffect('blindness');
    if (crit) damage *= 1.5;

    damage += enchBonus;
    if (damage <= 0) return false;

    const src = source('player_attack', this, { direct: this, noKnockback: true });
    let applied = false;
    if (_combat && typeof _combat.damageEntity === 'function') {
      try { applied = !!_combat.damageEntity(entity, damage, src); } catch (e) {
        console.error('[player] damageEntity failed', e);
        applied = entity.hurt(damage, src);
      }
    } else {
      applied = entity.hurt(damage, src);
    }

    if (!applied) {
      playAt('attack_nodamage', this.x, this.y, this.z, 0.3, 1);
      this.addExhaustion(EXH_ATTACK);
      return false;
    }

    // --- knockback --------------------------------------------------------
    let kb = 0.4;
    kb += knockbackBonus(stack) * 0.5;
    if (this.sprinting) { kb += 0.5; playAt('attack_knockback', this.x, this.y, this.z, 0.5, 1); }
    if (typeof entity.knockback === 'function') {
      entity.knockback(this.x - entity.x, this.z - entity.z, kb);
    }
    // A sprint hit spends its momentum on the victim.
    if (this.sprinting) { this.vx *= 0.6; this.vz *= 0.6; this.sprinting = false; }

    // --- fire aspect ------------------------------------------------------
    const fire = fireAspectSeconds(stack);
    if (fire > 0 && typeof entity.setOnFire === 'function') entity.setOnFire(fire);

    // --- crits and sweeping ----------------------------------------------
    if (crit) {
      playAt('crit', entity.x, entity.y + entity.height * 0.5, entity.z, 0.8, 1);
      particles('crit', entity.x, entity.y + entity.height * 0.6, entity.z, { count: 8, spread: 0.5 });
    }
    const sweeping = getEnchant(stack, 'sweeping');
    const tool = toolOf(stack);
    const isSword = !!(tool && tool.kind === 'sword');
    if (isSword && strength > 0.9 && this.onGround && !crit &&
        Math.hypot(this.vx, this.vz) < WALK_SPEED * 0.6) {
      this.sweepAttack(entity, damage, sweeping);
    }

    // --- wear and bookkeeping --------------------------------------------
    if (!isEmpty(stack)) {
      const def = getItem(stack.item);
      let handled = false;
      try { handled = !!def.onHitEntity(this, entity, stack); } catch { handled = false; }
      if (!handled && def.durability && this.gameMode !== GAMEMODE.CREATIVE) {
        damageStack(stack, tool && tool.kind === 'sword' ? 1 : 2, this);
      }
    }
    this.addExhaustion(EXH_ATTACK);
    playAt('attack_strong', this.x, this.y, this.z, 0.4, 1);
    if (entity.dead) this.stats.mobsKilled++;
    return true;
  }

  /** The sword arc that clips everything standing next to the main target. */
  sweepAttack(target, damage, sweeping) {
    const world = this.world;
    if (!world || typeof world.entitiesInAABB !== 'function') return;
    const sweepDamage = 1 + (sweeping > 0 ? (sweeping / (sweeping + 1)) * damage : 0);
    _scratchBox.set(target.x - 1, target.y - 0.25, target.z - 1,
      target.x + 1, target.y + target.height + 0.25, target.z + 1);
    let list = [];
    try {
      list = world.entitiesInAABB(_scratchBox, (e) => (
        e && e !== this && e !== target && !e.removed && !e.dead &&
        e.living === true && !NON_TARGET_TYPES.has(e.type)
      ));
    } catch { return; }
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (this.distanceTo(e) > 4) continue;
      if (typeof e.knockback === 'function') e.knockback(this.x - e.x, this.z - e.z, 0.4);
      e.hurt(sweepDamage, source('player_attack', this, { noKnockback: true }));
    }
    particles('sweep', this.x - Math.sin(this.yaw) * 1.2, this.y + 1,
      this.z + Math.cos(this.yaw) * 1.2, { count: 1, size: 1.6 });
    playAt('attack_sweep', this.x, this.y, this.z, 0.6, 1);
  }

  /** @override adds exhaustion, wakes the player and cancels sprinting. */
  hurt(amount, src = null) {
    const applied = super.hurt(amount, src);
    if (!applied) return false;
    this.addExhaustion(EXH_DAMAGE);
    this.sprinting = false;
    if (this.sleeping) this.wakeUp(true);
    if (this.usingItem) this.stopUsingItem();
    Game.emit('playerhurt', amount, src);
    return true;
  }

  // =========================================================================
  // Hunger, XP and items
  // =========================================================================

  /** Adds exhaustion, which burns saturation, then food, then health. */
  addExhaustion(n) {
    if (!(n > 0)) return;
    if (this.gameMode === GAMEMODE.CREATIVE || this.gameMode === GAMEMODE.SPECTATOR) return;
    if (Game.difficulty === DIFFICULTY.PEACEFUL) return;
    this.exhaustion = Math.min(40, this.exhaustion + n);
  }

  /** Points needed to finish the current level. */
  xpNeeded(level = this.xpLevel) {
    if (level >= 31) return 9 * level - 158;
    if (level >= 16) return 5 * level - 38;
    return 2 * level + 7;
  }

  /**
   * Grants (or, with a negative amount, removes) experience. Mending spends
   * the points on a damaged tool before the bar ever sees them.
   */
  addXP(amount) {
    let n = Math.round(amount || 0);
    if (!n) return 0;

    if (n > 0) {
      // Mending: repair a damaged enchanted item first.
      const candidates = [
        this.getEquipment(EQUIP.MAINHAND), this.getEquipment(EQUIP.OFFHAND),
        this.getEquipment(EQUIP.HEAD), this.getEquipment(EQUIP.CHEST),
        this.getEquipment(EQUIP.LEGS), this.getEquipment(EQUIP.FEET),
      ];
      for (let i = 0; i < candidates.length && n > 0; i++) {
        const s = candidates[i];
        if (isEmpty(s) || !(s.damage > 0)) continue;
        let spent = 0;
        try { spent = mendingRepair(s, n); } catch { spent = 0; }
        if (spent > 0) {
          n -= spent;
          particles('magic', this.x, this.y + 1, this.z, { count: 4, color: 0x77ff77 });
        }
      }
      if (n <= 0) return 0;
    }

    this.xp = Math.max(0, this.xp + n);
    const before = this.xpLevel;

    if (n > 0) {
      let left = n;
      let guard = 4096;
      while (left > 0 && guard-- > 0) {
        const need = Math.max(1, this.xpNeeded());
        const room = (1 - this.xpProgress) * need;
        if (left < room) { this.xpProgress += left / need; left = 0; }
        else { left -= room; this.xpLevel++; this.xpProgress = 0; }
      }
    } else {
      let left = -n;
      let guard = 4096;
      while (left > 0 && guard-- > 0) {
        const need = Math.max(1, this.xpNeeded());
        const have = this.xpProgress * need;
        if (left <= have) { this.xpProgress -= left / need; left = 0; }
        else if (this.xpLevel > 0) {
          left -= have;
          this.xpLevel--;
          this.xpProgress = 1;
        } else { this.xpProgress = 0; left = 0; }
      }
    }
    this.xpProgress = clamp(this.xpProgress, 0, 1);

    if (this.xpLevel > before) {
      // The level-up chime only fires on multiples of 5, like vanilla.
      if (this.xpLevel % 5 === 0 && this.xpCooldown <= 0) {
        this.xpCooldown = 10;
        playAt('level_up', this.x, this.y, this.z, 0.75, 1);
      }
      Game.emit('levelup', this.xpLevel);
    }
    return n;
  }

  /** Total points the player is carrying, used for the death drop. */
  totalXPPoints() {
    let total = Math.round(this.xpProgress * this.xpNeeded());
    for (let l = 0; l < this.xpLevel; l++) total += this.xpNeeded(l);
    return total;
  }

  /**
   * Adds a stack to the inventory.
   * @returns {object|null} the leftover stack, or null when it all fit
   */
  giveItem(stack) {
    if (isEmpty(stack) || !this.inventory) return stack || null;
    const left = this.inventory.add(stack);
    if (!left || left.count < stack.count) {
      playAt('item_pickup', this.x, this.y, this.z, 0.25, 1.6 + Math.random() * 0.3);
      Game.emit('itempickup', stack);
    }
    return left;
  }

  /**
   * Throws a stack into the world in front of the player.
   * @param {object} stack the stack to drop
   * @param {boolean} throwIt true for a real throw, false to let it fall
   */
  dropItem(stack, throwIt = true) {
    if (isEmpty(stack) || !this.world) return null;
    const d = this.getLookVec(_lookVec);
    const x = this.x + d.x * 0.3;
    const y = this.y + this.eyeHeight - 0.3;
    const z = this.z + d.z * 0.3;
    const speed = throwIt ? 6 : 1;
    this.spawnDropAt(x, y, z, stack,
      d.x * speed, d.y * speed + (throwIt ? 1.2 : 0.2), d.z * speed);
    this.swingArm();
    return stack;
  }

  /** Spawns a dropped-item entity, tolerating a missing itementity.js. */
  spawnDropAt(x, y, z, stack, vx = 0, vy = 1.5, vz = 0) {
    if (isEmpty(stack) || !this.world) return;
    if (_itementity && typeof _itementity.dropItem === 'function') {
      try {
        _itementity.dropItem(this.world, x, y, z, stack,
          vx + (Math.random() - 0.5) * 0.6, vy, vz + (Math.random() - 0.5) * 0.6);
        return;
      } catch (e) { console.error('[player] dropItem failed', e); }
    }
    const world = this.world;
    try {
      import('./itementity.js').then((m) => {
        _itementity = m;
        m.dropItem?.(world, x, y, z, stack, vx, vy, vz);
      }).catch(() => { /* itementity.js unavailable */ });
    } catch { /* no dynamic import */ }
  }

  /** Spawns XP orbs, tolerating a missing itementity.js. */
  spawnXPAt(x, y, z, amount) {
    if (!(amount > 0) || !this.world) return;
    if (_itementity && typeof _itementity.dropXP === 'function') {
      try { _itementity.dropXP(this.world, x, y, z, amount); return; } catch { /* optional */ }
    }
    // Without the orb entity the XP still has to land somewhere.
    this.addXP(amount);
  }

  // =========================================================================
  // Sleeping
  // =========================================================================

  /**
   * Climbs into a bed. Only works at night (or in a thunderstorm) and with no
   * monsters within eight blocks.
   * @returns {boolean} true when the player is now asleep
   */
  sleepIn(x, y, z) {
    const world = this.world;
    if (!world) return false;
    if (world.dimension && world.dimension !== DIM_OVERWORLD) {
      Game.toast('The bed explodes!');
      return false;
    }
    const night = typeof world.isNight === 'function' ? world.isNight() : false;
    const storm = !!(world.weather && world.weather.thunder > 0.5);
    if (!night && !storm) {
      Game.toast('You can only sleep at night');
      return false;
    }
    if (this.monstersNearby(8)) {
      Game.toast('You may not rest now, there are monsters nearby');
      return false;
    }

    this.sleeping = true;
    this.sleepTicks = 0;
    this.sleepPos = { x, y, z };
    this.setPosition(x + 0.5, y + 0.15, z + 0.5);
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.setRespawnPoint(x + 0.5, y + 1, z + 0.5);
    Game.emit('sleep', this);
    Game.toast('Sleeping...');
    return true;
  }

  /** Gets out of bed, optionally because something went wrong. */
  wakeUp(interrupted = false) {
    if (!this.sleeping) return;
    this.sleeping = false;
    this.sleepTicks = 0;
    const p = this.sleepPos;
    this.sleepPos = null;
    if (p) {
      const world = this.world;
      // Step out to any free block beside the bed.
      const spots = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]];
      for (const [dx, dz] of spots) {
        const nx = p.x + dx, nz = p.z + dz;
        if (world && replaceableAt(world, nx, p.y, nz) && replaceableAt(world, nx, p.y + 1, nz)) {
          this.setPosition(nx + 0.5, p.y, nz + 0.5);
          break;
        }
      }
    }
    Game.emit('wakeup', this, interrupted);
  }

  /** True when a hostile mob is within `r` blocks. */
  monstersNearby(r) {
    const world = this.world;
    if (!world || typeof world.entitiesNear !== 'function') return false;
    try {
      const list = world.entitiesNear(this.x, this.y, this.z, r, (e) => (
        e && !e.removed && !e.dead && e.def && e.def.category === 'hostile'
      ));
      return list.length > 0;
    } catch { return false; }
  }

  /** Remembers where a respawn should put the player. */
  setRespawnPoint(x, y, z) {
    this.respawnPoint = { x, y, z };
    Game.emit('spawnpoint', this.respawnPoint);
  }

  // =========================================================================
  // Death and respawn
  // =========================================================================

  /**
   * A totem of undying in either hand cancels the death, exactly once, and
   * leaves the player on half a heart with the usual buffs.
   * @returns {boolean} true when the death was cancelled
   */
  useTotem() {
    for (const slot of [EQUIP.MAINHAND, EQUIP.OFFHAND]) {
      const s = this.getEquipment(slot);
      if (isEmpty(s) || s.item !== 'totem_of_undying') continue;
      s.count -= 1;
      if (s.count <= 0) this.setEquipment(slot, null);
      this.health = 1;
      this.dead = false;
      this.fireTicks = 0;
      try { clearEffects(this, true); } catch { /* optional */ }
      this.addEffect('regeneration', 900, 1);
      this.addEffect('absorption', 100, 1);
      this.addEffect('fire_resistance', 800, 0);
      playAt('totem_use', this.x, this.y, this.z, 1, 1);
      particles('totem', this.x, this.y + 1, this.z, { count: 40, spread: 0.8, color: 0xffd700 });
      Game.toast('The totem shatters');
      return true;
    }
    return false;
  }

  /** @override drops the inventory and the XP, then shows the death screen. */
  kill(src = null) {
    if (this.dead) return;
    if (this.useTotem()) return;
    try { triggerDeathEffects(this); } catch { /* optional */ }
    this.dead = true;
    this.health = 0;
    this.deathTime = 0;
    this.lastDamageSource = src || this.lastDamageSource;
    this.sleeping = false;
    this.mining = false;
    this.usingItem = null;
    this.sprinting = false;
    this.flying = false;
    this.stats.deaths++;

    playAt('death', this.x, this.y, this.z, 0.9, 1);

    const world = this.world;
    const keep = !!(world && world.gameRules && world.gameRules.keepInventory);
    if (!keep && this.inventory && typeof this.inventory.dropContents === 'function') {
      let contents = [];
      try { contents = this.inventory.dropContents() || []; } catch { contents = []; }
      for (let i = 0; i < contents.length; i++) {
        const a = Math.random() * Math.PI * 2;
        this.spawnDropAt(this.x, this.y + 1, this.z, contents[i],
          Math.cos(a) * 1.5, 2.2, Math.sin(a) * 1.5);
      }
    }
    if (!keep) {
      const xp = Math.min(MAX_DEATH_XP, this.xpLevel * 7);
      if (xp > 0) this.spawnXPAt(this.x, this.y + 0.5, this.z, xp);
      this.xp = 0;
      this.xpLevel = 0;
      this.xpProgress = 0;
    }

    Game.emit('entitydeath', this, this.lastDamageSource);
    Game.emit('playerdeath', this.lastDamageSource);
    Game.log(this.deathMessage(this.lastDamageSource));
  }

  /** A vanilla-flavoured death message for the chat log. */
  deathMessage(src) {
    const who = src && src.entity ? (src.entity.display || prettyName(src.entity.type || 'something')) : null;
    switch (src && src.type) {
      case 'fall': return `${this.name} hit the ground too hard`;
      case 'lava': return `${this.name} tried to swim in lava`;
      case 'on_fire': case 'fire': return `${this.name} went up in flames`;
      case 'drown': return `${this.name} drowned`;
      case 'starve': return `${this.name} starved to death`;
      case 'in_wall': return `${this.name} suffocated in a wall`;
      case 'out_of_world': return `${this.name} fell out of the world`;
      case 'cactus': return `${this.name} was pricked to death`;
      case 'explosion': return `${this.name} blew up`;
      case 'magic': return `${this.name} was killed by magic`;
      case 'wither': return `${this.name} withered away`;
      case 'player_attack': case 'mob': return who ? `${this.name} was slain by ${who}` : `${this.name} was slain`;
      default: return who ? `${this.name} was killed by ${who}` : `${this.name} died`;
    }
  }

  /** Puts the player back together at their respawn point or the world spawn. */
  respawn() {
    const world = this.world || (Game.worlds && Game.worlds[DIM_OVERWORLD]) || null;
    this.dead = false;
    this.deathTime = 0;
    this.removed = false;
    this.health = this.maxHealth;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.airSupply = MAX_AIR;
    this.fireTicks = 0;
    this.fallDistance = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.hurtTime = 0;
    this.breakProgress = 0;
    this.breakTarget = null;
    this.usingItem = null;
    this.portalCooldown = 100;
    try { clearEffects(this, false); } catch { /* optional */ }

    let spot = this.respawnPoint;
    if (!spot && world && world.spawnPoint) spot = world.spawnPoint;
    if (!spot) spot = { x: 0.5, y: SEA_LEVEL + 2, z: 0.5 };

    let x = spot.x, y = spot.y, z = spot.z;
    if (world) {
      // Never respawn inside the floor: find the surface at that column.
      try {
        const h = world.getHeight(Math.floor(x), Math.floor(z));
        if (Number.isFinite(h)) y = clamp(Math.max(y, h), 1, WORLD_HEIGHT - 3);
      } catch { /* keep the stored y */ }
    }
    this.setPosition(x, y, z);
    if (world && this.world !== world) this.world = world;
    if (world && typeof world.addEntity === 'function' && world.entities &&
        world.entities.indexOf(this) < 0) {
      world.addEntity(this);
    }
    Game.gameOver = false;
    Game.emit('playerrespawn');
  }

  /** Moves the player, optionally into another dimension. */
  teleport(x, y, z, dimension = null) {
    if (dimension && Game.worlds && Game.worlds[dimension] && Game.worlds[dimension] !== this.world) {
      const from = this.world ? this.world.dimension : DIM_OVERWORLD;
      this.setPosition(x, y, z);
      this.portalCooldown = 200;
      Game.emit('dimensionchange', from, dimension);
      // The integrator swaps the worlds; put us exactly where we asked after.
      this.setPosition(x, y, z);
      return true;
    }
    this.setPosition(x, y, z);
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.fallDistance = 0;
    return true;
  }

  // =========================================================================
  // Camera
  // =========================================================================

  /**
   * main.js drives the camera from `(pitch, yaw)` in three.js 'YXZ' order,
   * which is a different orientation from the vanilla look vector every other
   * module uses. Rather than fight it every frame, the player takes ownership
   * of the final camera transform by re-aiming it just before three.js builds
   * the matrix. Idempotent, and a no-op when there is no camera.
   */
  _installCameraFix() {
    if (this._cameraPatched) return;
    const cam = Game.camera;
    if (!cam || typeof cam.updateMatrixWorld !== 'function') return;
    if (cam.__mc67PlayerCamera) { this._cameraPatched = true; return; }
    const base = cam.updateMatrixWorld;
    cam.updateMatrixWorld = function patchedUpdateMatrixWorld(force) {
      // Reads Game.player rather than a captured instance so a respawn or a
      // freshly loaded world keeps driving the same camera.
      try {
        const p = Game.player;
        if (p && typeof p._aimCamera === 'function') p._aimCamera(this);
      } catch { /* never break the render */ }
      return base.call(this, force);
    };
    cam.__mc67PlayerCamera = true;
    this._cameraPatched = true;
  }

  /** Points a camera along the player's look vector, in whichever perspective. */
  _aimCamera(cam) {
    if (Game.player !== this || !Game.started) return;
    const eyeY = this.y + this.eyeHeight;
    const dx = cam.position.x - this.x;
    const dy = cam.position.y - eyeY;
    const dz = cam.position.z - this.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const fwd = this.getLookVec(_camVec);

    if (dist < 0.75) {
      // First person. (pitch, yaw) -> (-pitch, PI - yaw) converts the vanilla
      // angles into the three.js YXZ Euler that looks the same way.
      cam.rotation.set(-this.pitch, Math.PI - this.yaw, 0, 'YXZ');
      return;
    }

    // Third person: main.js already chose front or back; honour that choice.
    const front = Math.abs(angleDiff(cam.rotation.y, this.yaw)) > 1.5;
    const sign = front ? 1 : -1;
    const d = this._cameraClearance(fwd, sign, dist);
    cam.position.set(this.x + fwd.x * d * sign, eyeY + fwd.y * d * sign, this.z + fwd.z * d * sign);
    if (front) cam.rotation.set(this.pitch, -this.yaw, 0, 'YXZ');
    else cam.rotation.set(-this.pitch, Math.PI - this.yaw, 0, 'YXZ');
  }

  /** Pulls the third-person camera in when a wall is in the way. */
  _cameraClearance(fwd, sign, want) {
    const world = this.world;
    if (!world || typeof world.raycast !== 'function') return want;
    try {
      const hit = world.raycast(this.x, this.y + this.eyeHeight, this.z,
        fwd.x * sign, fwd.y * sign, fwd.z * sign, want, { solidOnly: true });
      if (hit) return Math.max(0.6, hit.distance - 0.25);
    } catch { /* optional */ }
    return want;
  }

  /** Sprint, flight, bow charge and the zoom key all bend the field of view. */
  _updateFov(dt) {
    const cam = Game.camera;
    if (!cam || typeof cam.updateProjectionMatrix !== 'function') return;
    let base = 70;
    try {
      const v = Game.settings && Game.settings.get('fov');
      if (Number.isFinite(v)) base = v;
    } catch { /* defaults are fine */ }

    let mul = 1;
    if (this.sprinting) mul *= 1.15;
    if (this.flying && this.sprinting) mul *= 1.08;
    if (this.hasEffect('speed')) mul *= 1.05;
    if (this.hasEffect('slowness')) mul *= 0.92;
    if (this.usingItem) {
      const def = getItem(this.usingItem.item);
      if (def.useAction === 'bow') mul *= 1 - clamp(this.useTicks / 20, 0, 1) * 0.15;
      else if (def.useAction === 'spyglass') mul *= 0.15;
    }
    if (this.zooming) mul *= 0.3;

    const target = clamp(base * mul, 8, 150);
    const k = Math.min(1, dt * 9);
    const next = cam.fov + (target - cam.fov) * k;
    if (Math.abs(next - this._lastFov) > 0.01) {
      cam.fov = next;
      this._lastFov = next;
      cam.updateProjectionMatrix();
    }
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  /** @override adds the player-specific fields save.js wants. */
  serialize() {
    const base = super.serialize();
    base.type = 'player';
    base.name = this.name;
    base.hunger = this.hunger;
    base.saturation = this.saturation;
    base.exhaustion = this.exhaustion;
    base.xp = this.xp;
    base.xpLevel = this.xpLevel;
    base.xpProgress = this.xpProgress;
    base.gameMode = this.gameMode;
    base.flying = this.flying;
    base.canFly = this.canFly;
    base.sneaking = this.sneaking;
    base.sprinting = this.sprinting;
    base.selectedSlot = this.selectedSlot;
    base.respawnPoint = this.respawnPoint ? { ...this.respawnPoint } : null;
    base.stats = { ...this.stats };
    try { base.inventory = this.inventory.serialize(); } catch { base.inventory = null; }
    try { base.enderChest = this.enderChest.serialize(); } catch { base.enderChest = null; }
    return base;
  }

  /** Alias so save.js can call either spelling. */
  save() { return this.serialize(); }

  /** @override restores everything `serialize()` wrote. */
  load(obj) {
    if (!obj) return this;
    super.load(obj);
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.name = typeof obj.name === 'string' ? obj.name : this.name;
    this.hunger = clamp(num(obj.hunger, this.hunger), 0, MAX_HUNGER);
    this.saturation = Math.max(0, num(obj.saturation, this.saturation));
    this.exhaustion = Math.max(0, num(obj.exhaustion, 0));
    this.xp = Math.max(0, num(obj.xp, 0));
    this.xpLevel = Math.max(0, num(obj.xpLevel, 0) | 0);
    this.xpProgress = clamp(num(obj.xpProgress, 0), 0, 1);
    if (typeof obj.gameMode === 'string') this.setGameMode(obj.gameMode);
    if (typeof obj.canFly === 'boolean') this.canFly = obj.canFly;
    if (typeof obj.flying === 'boolean') this.flying = obj.flying && this.canFly;
    if (obj.respawnPoint) this.respawnPoint = { ...obj.respawnPoint };
    if (obj.stats && typeof obj.stats === 'object') Object.assign(this.stats, obj.stats);
    if (obj.inventory && this.inventory) {
      try { this.inventory.load(obj.inventory); } catch (e) { console.warn('[player] inventory load failed', e); }
    }
    if (obj.enderChest && this.enderChest) {
      try { this.enderChest.load(obj.enderChest); } catch { /* optional */ }
    }
    if (typeof obj.selectedSlot === 'number') this.selectedSlot = obj.selectedSlot;
    this.dead = false;
    this.health = clamp(num(obj.health, this.maxHealth), 0.0001, this.maxHealth);
    return this;
  }

  /** Switches game mode and fixes up the flags that depend on it. */
  setGameMode(mode) {
    if (!mode || mode === this.gameMode) return this.gameMode;
    this.gameMode = mode;
    this.canFly = mode === GAMEMODE.CREATIVE || mode === GAMEMODE.SPECTATOR;
    if (!this.canFly) this.flying = false;
    if (mode === GAMEMODE.SPECTATOR) { this.flying = true; this.noClip = true; }
    else this.noClip = false;
    this.cancelMining();
    Game.mode = mode;
    Game.emit('gamemodechange', mode);
    return this.gameMode;
  }
}

registerEntityType('player', Player);

export default Player;
