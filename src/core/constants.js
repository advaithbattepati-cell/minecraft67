// ============================================================================
// constants.js - Global constants. Imported by nearly everything.
// This module has NO imports of its own. Never add any.
// ============================================================================

// ---- World geometry --------------------------------------------------------
export const CHUNK_X = 16;
export const CHUNK_Z = 16;
export const WORLD_HEIGHT = 128;          // y in [0, 127]
export const CHUNK_AREA = CHUNK_X * CHUNK_Z;              // 256
export const CHUNK_VOLUME = CHUNK_AREA * WORLD_HEIGHT;    // 32768
export const SEA_LEVEL = 62;
export const BEDROCK_LEVEL = 0;
export const NETHER_ROOF = 120;
export const MAX_BUILD_HEIGHT = WORLD_HEIGHT - 1;

// Index helpers for the per-chunk flat arrays. Layout: y-major, then z, then x.
export const chunkIndex = (x, y, z) => (y << 8) | (z << 4) | x;
export const idxX = (i) => i & 15;
export const idxZ = (i) => (i >> 4) & 15;
export const idxY = (i) => i >> 8;

// ---- Block value packing ---------------------------------------------------
// A block "value" is a Uint16: low 12 bits = block id, high 4 bits = metadata.
export const ID_MASK = 0x0fff;
export const META_SHIFT = 12;
export const MAX_BLOCK_ID = 0x0fff;   // 4095
export const MAX_META = 15;
export const packBlock = (id, meta = 0) => (id & ID_MASK) | ((meta & 15) << META_SHIFT);
export const blockId = (v) => v & ID_MASK;
export const blockMeta = (v) => (v >>> META_SHIFT) & 15;
export const withMeta = (v, meta) => (v & ID_MASK) | ((meta & 15) << META_SHIFT);

// ---- Light -----------------------------------------------------------------
export const MAX_LIGHT = 15;
export const packLight = (sky, block) => ((sky & 15) << 4) | (block & 15);
export const skyLightOf = (l) => (l >> 4) & 15;
export const blockLightOf = (l) => l & 15;

// ---- Time ------------------------------------------------------------------
export const TICKS_PER_SECOND = 20;
export const TICK_MS = 1000 / TICKS_PER_SECOND;
export const DAY_LENGTH_TICKS = 24000;    // 20 real minutes
export const TIME_SUNRISE = 23000;
export const TIME_DAY = 1000;
export const TIME_NOON = 6000;
export const TIME_SUNSET = 12000;
export const TIME_NIGHT = 13000;
export const TIME_MIDNIGHT = 18000;

// ---- Physics ---------------------------------------------------------------
export const GRAVITY = 32.0;              // blocks / s^2
export const TERMINAL_VELOCITY = 78.4;
export const JUMP_VELOCITY = 8.95;        // ~1.25 block jump
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const PLAYER_EYE_SNEAK = 1.42;
export const SNEAK_HEIGHT = 1.5;
export const STEP_HEIGHT = 0.6;
export const WALK_SPEED = 4.317;
export const SPRINT_SPEED = 5.612;
export const SNEAK_SPEED = 1.31;
export const FLY_SPEED = 10.9;
export const SWIM_SPEED = 2.2;
export const REACH_SURVIVAL = 4.5;
export const REACH_CREATIVE = 5.0;

// ---- Directions ------------------------------------------------------------
// Canonical face order used by the mesher, block models and metadata.
export const FACE_DOWN = 0, FACE_UP = 1, FACE_NORTH = 2, FACE_SOUTH = 3, FACE_WEST = 4, FACE_EAST = 5;
export const FACE_NAMES = ['down', 'up', 'north', 'south', 'west', 'east'];
// north = -Z, south = +Z, west = -X, east = +X
export const FACE_DIRS = [
  [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0],
];
export const FACE_OPPOSITE = [1, 0, 3, 2, 5, 4];
// Horizontal facing index used in metadata: 0=north(-Z) 1=east(+X) 2=south(+Z) 3=west(-X)
export const HFACE_NORTH = 0, HFACE_EAST = 1, HFACE_SOUTH = 2, HFACE_WEST = 3;
export const HFACE_DIRS = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]];
export const HFACE_TO_FACE = [FACE_NORTH, FACE_EAST, FACE_SOUTH, FACE_WEST];
export const HFACE_YAW = [Math.PI, -Math.PI / 2, 0, Math.PI / 2];

// ---- Gameplay --------------------------------------------------------------
export const GAMEMODE = { SURVIVAL: 'survival', CREATIVE: 'creative', ADVENTURE: 'adventure', SPECTATOR: 'spectator' };
export const DIFFICULTY = { PEACEFUL: 0, EASY: 1, NORMAL: 2, HARD: 3 };
export const DIM_OVERWORLD = 'overworld';
export const DIM_NETHER = 'nether';
export const DIM_END = 'end';
export const NETHER_SCALE = 8;

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const MAX_AIR = 300;             // ticks underwater
export const MAX_ABSORPTION = 20;

// Tool tiers
export const TIER = { WOOD: 0, STONE: 1, IRON: 2, DIAMOND: 3, NETHERITE: 4, GOLD: 0.5 };
export const TIER_NAMES = ['wood', 'stone', 'iron', 'diamond', 'netherite'];

// Inventory layout
export const HOTBAR_SIZE = 9;
export const INV_MAIN_SIZE = 36;        // slots 0..8 hotbar, 9..35 backpack
export const ARMOR_SLOTS = 4;           // 0 head, 1 chest, 2 legs, 3 feet
export const ARMOR_HEAD = 0, ARMOR_CHEST = 1, ARMOR_LEGS = 2, ARMOR_FEET = 3;
export const ARMOR_SLOT_NAMES = ['head', 'chest', 'legs', 'feet'];

// Render
export const DEFAULT_RENDER_DISTANCE = 8;
export const MIN_RENDER_DISTANCE = 2;
export const MAX_RENDER_DISTANCE = 16;

// Sound category names
export const SOUND_CATEGORIES = ['master', 'music', 'blocks', 'hostile', 'neutral', 'players', 'ambient', 'weather'];
