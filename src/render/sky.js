// ============================================================================
// sky.js - Sky dome, sun, moon, stars, clouds, fog, weather and lightning.
// CONTRACT.md section 18.
//
// Everything here is procedural: two small canvases (a sun disc and an
// 8-phase moon sheet), one 256x256 seamless noise cloud sheet, and a seeded
// star field. No image files, no network.
//
// Fog policy: chunkrenderer.js owns a THREE.Fog and mirrors our numbers into
// it every frame (it reads Game.sky.fogColor / fogNear / fogFar). We ALSO
// write straight into scene.fog so the horizon is correct even when the chunk
// renderer failed to construct. Both paths agree, so there is no fight.
// ============================================================================
import * as THREE from 'three';

import { Game } from '../core/game.js';
import {
  DIM_OVERWORLD, DIM_NETHER, DIM_END,
  CHUNK_X, WORLD_HEIGHT, DEFAULT_RENDER_DISTANCE,
} from '../core/constants.js';
import { clamp, lerp, mixHex, rgbToHex, hexToRgb } from '../core/util.js';
import { RNG, Noise } from '../core/rng.js';
import { getBlock as blockDef } from '../world/blocks.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const CLOUD_Y = WORLD_HEIGHT;          // 128 - just above the build limit
const CLOUD_THICKNESS = 4;             // vertical gap between the fancy layers
const CLOUD_TEX = 256;                 // texels in the cloud sheet
const CLOUD_BLOCKS_PER_TEXEL = 12;     // vanilla cloud cell size
const CLOUD_SPAN = CLOUD_TEX * CLOUD_BLOCKS_PER_TEXEL;   // 3072 blocks per tile
const CLOUD_PLANE = 6144;              // plane size (exactly two tiles)
const CLOUD_SPEED = 0.6;               // blocks / second, +X like vanilla

const STAR_COUNT = 1600;
const RAIN_DROPS = 2600;
const SNOW_FLAKES = 1700;
const SPLASH_MAX = 260;
const BOLT_POINTS = 18;

// Night / dawn / dusk palette. Vanilla drives the sky straight off the biome
// colour and a daylight factor; these are the floors it falls to.
const NIGHT_ZENITH = 0x02040c;
const NIGHT_HORIZON = 0x0a1024;
const GROUND_TINT = 0x0e1420;

const NETHER_BASE_FOG = 0x330707;
const END_FOG = 0x38303f;
const END_ZENITH = 0x0a0611;
const END_HORIZON = 0x1a0f26;

const WATER_FOG_TINT = 0x0c4d5c;
const LAVA_FOG = 0x991900;
const SNOW_FOG = 0xd8e4ee;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Reads a settings value without ever throwing. */
function setting(key, dflt) {
  try {
    const s = Game.settings;
    if (!s || typeof s.get !== 'function') return dflt;
    const v = s.get(key);
    return v === undefined || v === null ? dflt : v;
  } catch {
    return dflt;
  }
}

/** Render distance in chunks, clamped to something sane. */
function renderDistance() {
  const v = Number(setting('renderDistance', DEFAULT_RENDER_DISTANCE));
  return clamp(Number.isFinite(v) ? v : DEFAULT_RENDER_DISTANCE, 2, 32);
}

/**
 * Vanilla's celestial angle: 0 at noon, 0.5 at midnight, eased slightly so the
 * sun lingers near the horizon. Input is day time in ticks.
 */
export function celestialAngle(timeTicks) {
  const day = (((timeTicks | 0) % 24000) + 24000) % 24000;
  let f = day / 24000 - 0.25;
  if (f < 0) f += 1;
  return f + ((1 - Math.cos(f * Math.PI)) / 2 - f) / 3;
}

/** 0..1 daylight strength derived from the celestial angle (1 = noon). */
function daylight(theta) {
  return clamp(Math.cos(theta) * 2 + 0.5, 0, 1);
}

/**
 * Vanilla's sunrise/sunset band: returns 0 outside the dawn/dusk windows,
 * otherwise an alpha, and writes the warm colour into `out` as a hex int.
 */
function sunriseGlow(theta, out) {
  const f = Math.cos(theta);
  if (f < -0.4 || f > 0.4) { out.hex = 0xff9a4d; return 0; }
  const g = (f / 0.4) * 0.5 + 0.5;
  let a = 1 - (1 - Math.sin(g * Math.PI)) * 0.99;
  a *= a;
  out.hex = rgbToHex(g * 0.3 + 0.7, g * g * 0.7 + 0.2, 0.2);
  return clamp(a, 0, 1);
}

/** Multiplies a packed hex colour by a scalar. */
function scaleHex(hex, k) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * k, g * k, b * k);
}

/** Frame-rate independent approach towards a target hex colour. */
function driftHex(cur, target, rate, dt) {
  if (cur === target) return target;
  return mixHex(cur, target, clamp(rate * dt, 0, 1));
}

/** Block definition at an integer position, or null when out of the world. */
function defAt(world, x, y, z) {
  if (!world || y < 0 || y >= WORLD_HEIGHT) return null;
  try {
    const id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    return id ? blockDef(id) : null;
  } catch {
    return null;
  }
}

const _glowScratch = { hex: 0xff9a4d };

/**
 * The tint that block light is multiplied by before it reaches the screen.
 * Warm at dawn and dusk, cold and blue at night, near-white at noon, and it
 * flashes towards white while lightning is striking.
 * @param {object} world
 * @returns {{r:number,g:number,b:number}} per-channel multipliers, 0..1
 */
export function skyLightColor(world) {
  const dim = world?.dimension || DIM_OVERWORLD;
  if (dim === DIM_NETHER) return { r: 1.0, g: 0.72, b: 0.58 };
  if (dim === DIM_END) return { r: 0.82, g: 0.78, b: 1.0 };

  const theta = celestialAngle(world?.time ?? 6000) * TAU;
  const day = daylight(theta);

  // Night is a cool blue, noon is neutral.
  let r = lerp(0.58, 1.0, day);
  let g = lerp(0.62, 1.0, day);
  let b = lerp(0.86, 1.0, day);

  // Dawn / dusk push everything warm without draining the greens.
  const glow = sunriseGlow(theta, _glowScratch);
  if (glow > 0) {
    const k = glow * 0.6;
    r = lerp(r, 1.0, k);
    g = lerp(g, 0.80, k);
    b = lerp(b, 0.62, k);
  }

  // Rain and thunder desaturate and dim.
  const w = world?.weather;
  if (w) {
    const wet = clamp((w.rain || 0) * 0.35 + (w.thunder || 0) * 0.25, 0, 0.6);
    if (wet > 0) {
      const grey = (r + g + b) / 3;
      r = lerp(r, grey * 0.88, wet);
      g = lerp(g, grey * 0.9, wet);
      b = lerp(b, grey * 0.98, wet);
    }
  }

  if ((world?.lightningTicks | 0) > 0) {
    const k = clamp(world.lightningTicks / 8, 0, 1) * 0.7;
    r = lerp(r, 1, k); g = lerp(g, 1, k); b = lerp(b, 1, k);
  }

  return { r: clamp(r, 0, 1), g: clamp(g, 0, 1), b: clamp(b, 0, 1) };
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finishTexture(canvas, { repeat = false, nearest = true, mips = false } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = !!mips;
  tex.anisotropy = 1;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** A soft sun disc with a warm corona. */
function makeSunTexture() {
  const S = 96;
  const c = newCanvas(S, S);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0.00, 'rgba(255,255,246,1)');
  g.addColorStop(0.26, 'rgba(255,251,214,1)');
  g.addColorStop(0.33, 'rgba(255,236,168,0.96)');
  g.addColorStop(0.40, 'rgba(255,205,110,0.42)');
  g.addColorStop(0.62, 'rgba(255,170,70,0.12)');
  g.addColorStop(1.00, 'rgba(255,150,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return finishTexture(c, { nearest: false });
}

/**
 * A 4x2 sheet of 64px moon phases, index 0 = full moon, walking through
 * waning -> new -> waxing exactly like the vanilla moon_phases sheet.
 */
function makeMoonTexture() {
  const CELL = 64, COLS = 4, ROWS = 2;
  const c = newCanvas(CELL * COLS, CELL * ROWS);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);

  // A reusable full moon on its own canvas, so phases can be masked cleanly.
  const disc = newCanvas(CELL, CELL);
  const dctx = disc.getContext('2d');
  const r = 25, cx = CELL / 2, cy = CELL / 2;
  const grad = dctx.createRadialGradient(cx - 6, cy - 7, 2, cx, cy, r);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.55, '#e6ebf5');
  grad.addColorStop(1, '#b9c2d4');
  dctx.beginPath();
  dctx.arc(cx, cy, r, 0, TAU);
  dctx.closePath();
  dctx.fillStyle = grad;
  dctx.fill();

  // Maria: a handful of soft dark patches, seeded so the moon never changes.
  const rng = new RNG(0x1e0a);
  dctx.save();
  dctx.beginPath();
  dctx.arc(cx, cy, r, 0, TAU);
  dctx.clip();
  for (let i = 0; i < 11; i++) {
    const a = rng.float(0, TAU);
    const d = Math.sqrt(rng.next()) * (r - 4);
    const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
    const rr = rng.float(2.5, 7.5);
    const gg = dctx.createRadialGradient(px, py, 0, px, py, rr);
    gg.addColorStop(0, 'rgba(150,160,180,0.55)');
    gg.addColorStop(1, 'rgba(150,160,180,0)');
    dctx.fillStyle = gg;
    dctx.beginPath();
    dctx.arc(px, py, rr, 0, TAU);
    dctx.fill();
  }
  dctx.restore();

  // A large erasing circle gives an almost-straight terminator.
  const R = r * 6;
  for (let p = 0; p < 8; p++) {
    const col = p % COLS, row = (p / COLS) | 0;
    const ox = col * CELL, oy = row * CELL;
    ctx.save();
    ctx.translate(ox, oy);
    // The erasing circle is far bigger than a cell, so clip to this one or it
    // scrubs out the phases drawn beside it.
    ctx.beginPath();
    ctx.rect(0, 0, CELL, CELL);
    ctx.clip();
    ctx.drawImage(disc, 0, 0);
    if (p !== 0) {
      const ang = (p / 8) * TAU;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      if (p <= 4) {
        // dark side on the left, boundary at cx + b
        const b = -r * Math.cos(ang);
        ctx.arc(cx + b - R, cy, R, 0, TAU);
      } else {
        // dark side on the right
        const b = r * Math.cos(ang);
        ctx.arc(cx + b + R, cy, R, 0, TAU);
      }
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }
  return finishTexture(c, { nearest: false });
}

/**
 * A seamless 256x256 cloud sheet. One texel is one 12-block cloud cell, so the
 * sheet tiles every 3072 blocks and the edges match by construction (four
 * shifted noise samples cross-faded).
 */
function makeCloudTexture() {
  const N = CLOUD_TEX;
  const c = newCanvas(N, N);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const data = img.data;
  const noise = new Noise(0x510ad);
  const detail = new Noise(0x51ad2);
  // One noise unit must span roughly ten texels, not fifty. At 5/N a single
  // cloud bank was ~600 blocks across, so from just below the layer it covered
  // the entire sky as one flat white sheet. 22/N puts banks at 130-260 blocks,
  // which reads as distinct clouds with sky between them.
  const s = 22 / N;
  const sample = (x, y) => noise.fbm2(x * s, y * s, 4, 2.1, 0.52);

  const THRESH = 0.10;
  for (let y = 0; y < N; y++) {
    const wy = y / N;
    for (let x = 0; x < N; x++) {
      const wx = x / N;
      // Cross-fade four shifted samples so the tile wraps with no seam.
      const v =
        sample(x, y) * (1 - wx) * (1 - wy) +
        sample(x - N, y) * wx * (1 - wy) +
        sample(x, y - N) * (1 - wx) * wy +
        sample(x - N, y - N) * wx * wy;
      const i = (y * N + x) * 4;
      if (v > THRESH) {
        // Slight interior variation keeps big banks from looking like paint.
        const d = detail.simplex2(x * 0.09, y * 0.09) * 0.5 + 0.5;
        const shade = clamp(0.88 + (v - THRESH) * 0.8 + d * 0.1, 0.82, 1);
        const q = Math.round(255 * shade);
        data[i] = q; data[i + 1] = q; data[i + 2] = Math.min(255, q + 4);
        data[i + 3] = 235;
      } else {
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(c, { repeat: true, nearest: true, mips: true });
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const DOME_VERT = `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec2 uSunHoriz;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform float uHalo;
uniform vec3 uBlend;
uniform float uBlendAmt;
uniform float uSwirl;
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  float t = pow(clamp(h * 1.5, 0.0, 1.0), 0.7);
  vec3 col = mix(uHorizon, uZenith, t);
  col = mix(col, uGround, clamp(-h * 2.6, 0.0, 1.0));

  // Dawn / dusk band, hugging the horizon on the sun's side of the sky.
  float band = clamp(1.0 - abs(h) * 2.4, 0.0, 1.0);
  band *= band;
  vec2 hd = normalize(dir.xz + vec2(1e-5, 0.0));
  float toward = max(dot(hd, uSunHoriz), 0.0);
  col += uGlow * (uGlowAmt * band * pow(toward, 3.0));

  // Halo hugging the sun disc itself.
  float d = max(dot(dir, uSunDir), 0.0);
  col += uGlow * (uHalo * pow(d, 42.0));

  if (uSwirl > 0.001) {
    float v = sin(dir.x * 8.0 + dir.z * 6.0) * sin(dir.y * 11.0 - dir.x * 4.0);
    col += vec3(0.040, 0.012, 0.068) * uSwirl * (0.5 + 0.5 * v);
  }

  col = mix(col, uBlend, uBlendAmt);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const STAR_VERT = `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixel;
varying float vTw;
varying float vY;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vTw = 0.62 + 0.38 * sin(uTime * 1.6 + aPhase);
  vY = normalize(position).y;
  gl_PointSize = aSize * uPixel;
}
`;

const STAR_FRAG = `
uniform float uOpacity;
uniform vec3 uColor;
uniform float uHorizonFade;
varying float vTw;
varying float vY;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  float a = smoothstep(0.25, 0.02, d);
  a *= uOpacity * vTw * mix(1.0, smoothstep(-0.06, 0.20, vY), uHorizonFade);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CLOUD_VERT = `
uniform vec2 uUvOffset;
uniform float uUvScale;
varying vec2 vUv;
varying vec2 vXZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vUv = (wp.xz + uUvOffset) * uUvScale;
  vXZ = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CLOUD_FRAG = `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uShade;
uniform float uFadeStart;
uniform float uFadeEnd;
varying vec2 vUv;
varying vec2 vXZ;
void main() {
  vec4 texel = texture2D(uMap, vUv);
  float a = smoothstep(0.28, 0.62, texel.a);
  if (a < 0.02) discard;
  float fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, length(vXZ - cameraPosition.xz));
  if (fade <= 0.003) discard;
  vec3 col = uColor * texel.rgb * uShade;
  gl_FragColor = vec4(col, a * uOpacity * fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// One shared precipitation shader. Drops live in a wrapping box that follows
// the camera; wrapping happens in the vertex shader so nothing is uploaded
// per frame.
const PRECIP_VERT = `
attribute vec3 aPos;
attribute float aRand;
uniform vec3 uCenter;
uniform vec3 uExtent;
uniform float uTime;
uniform float uFall;
uniform float uSway;
uniform float uWidth;
uniform float uStretch;
varying vec2 vUv;
varying float vFade;
varying float vRand;
void main() {
  vec3 p = aPos * uExtent;
  float speed = uFall * (0.72 + 0.56 * aRand);
  p.y = mod(p.y - uTime * speed, uExtent.y);
  p.x = mod(p.x + sin(uTime * (0.5 + aRand * 0.9) + aRand * 6.2831) * uSway, uExtent.x);
  p.z = mod(p.z + cos(uTime * (0.43 + aRand * 0.8) + aRand * 4.1) * uSway, uExtent.z);
  vec3 world = uCenter + p - uExtent * 0.5;

  vec3 toCam = cameraPosition - world;
  float dist = length(toCam.xz);
  vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x) + vec3(1e-4, 0.0, 0.0));
  world += right * (position.x * uWidth);
  world.y += position.y * uStretch;

  float edge = 1.0 - smoothstep(uExtent.x * 0.28, uExtent.x * 0.5, dist);
  vFade = edge * smoothstep(0.35, 1.7, dist);
  vUv = uv;
  vRand = aRand;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const PRECIP_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uRound;
varying vec2 vUv;
varying float vFade;
varying float vRand;
void main() {
  float a;
  if (uRound > 0.5) {
    vec2 c = vUv - 0.5;
    a = smoothstep(0.25, 0.03, dot(c, c));
  } else {
    a = smoothstep(0.0, 0.22, vUv.y) * (1.0 - smoothstep(0.72, 1.0, vUv.y));
    a *= 1.0 - abs(vUv.x - 0.5) * 1.9;
    a = pow(max(a, 0.0), 0.65);
  }
  a *= uOpacity * vFade * (0.65 + 0.35 * vRand);
  if (a <= 0.006) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SPLASH_VERT = `
attribute float aLife;
uniform float uPixel;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vA = clamp(aLife, 0.0, 1.0);
  float size = (1.6 + 2.4 * vA) * uPixel * 26.0 / max(0.6, -mv.z);
  gl_PointSize = clamp(size, 1.0, 22.0);
}
`;

const SPLASH_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.25, 0.04, dot(c, c)) * vA * uOpacity;
  if (a <= 0.006) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const BOLT_VERT = `
attribute float aSide;
attribute float aWidth;
void main() {
  vec3 wp = position;
  vec3 toCam = cameraPosition - wp;
  vec3 right = normalize(cross(toCam, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  wp += right * (aSide * aWidth);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const BOLT_FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

/** A unit quad in the XY plane, ready to be instanced. */
function instancedQuad(count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);

  const pos = new Float32Array(count * 3);
  const rand = new Float32Array(count);
  const rng = new RNG(0xd40b1 + count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rng.next();
    pos[i * 3 + 1] = rng.next();
    pos[i * 3 + 2] = rng.next();
    rand[i] = rng.next();
  }
  g.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 1));
  g.instanceCount = count;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(scene, camera) {
    this.scene = scene || null;
    this.camera = camera || null;
    this.dimension = DIM_OVERWORLD;
    this.disposed = false;

    // --- published state -------------------------------------------------
    this._fogColor = new THREE.Color(0xa8c8f0);
    this.fogNear = 40;
    this.fogFar = 160;
    this.fogDensity = 0;
    this.skyTopColor = new THREE.Color(0x78a7ff);
    this.skyHorizonColor = new THREE.Color(0xc0d8ff);
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.moonPhase = 0;
    this.dayFactor = 1;
    this.nightFactor = 0;
    this.rain = 0;
    this.thunder = 0;
    this.lightningFlash = 0;
    this.submerged = 'none';        // 'none' | 'water' | 'lava' | 'powder_snow'

    // --- smoothed inputs -------------------------------------------------
    this._time = 0;
    this._biomeSkyHex = 0x78a7ff;
    this._biomeFogHex = 0xc0d8ff;
    this._waterFogHex = 0x1a4a63;
    this._fogHex = 0xa8c8f0;
    this._roofFade = 1;             // 1 outdoors, ~0.15 under a roof
    this._precip = 'rain';

    // --- scratch (no per-frame allocation) -------------------------------
    this._v3 = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._forward = new THREE.Vector3(0, 0, 1);
    this._glow = { hex: 0xff9a4d };

    // --- scene graph ------------------------------------------------------
    this.celestial = new THREE.Group();      // sits at the camera, unit sized
    this.celestial.name = 'sky-celestial';
    this.celestial.frustumCulled = false;
    this.world = new THREE.Group();          // clouds + weather, world space
    this.world.name = 'sky-world';
    this.world.frustumCulled = false;
    if (this.scene) {
      this.scene.add(this.celestial);
      this.scene.add(this.world);
    }

    this._disposables = [];
    try {
      this._buildDome();
      this._buildStars();
      this._buildSunMoon();
      this._buildClouds();
      this._buildWeather();
      this._buildBolt();
    } catch (err) {
      console.error('[sky] build failed', err);
    }

    // --- fog ownership ----------------------------------------------------
    this._fog = null;
    if (this.scene) {
      if (this.scene.fog && typeof this.scene.fog.near === 'number') {
        this._fog = this.scene.fog;          // chunkrenderer already made one
      } else {
        this._fog = new THREE.Fog(this._fogHex, this.fogNear, this.fogFar);
        this.scene.fog = this._fog;
        this._ownsFog = true;
      }
    }

    // --- lightning --------------------------------------------------------
    this._offLightning = null;
    try {
      this._offLightning = Game.on('lightning', (x, y, z) => this.strike(x, y, z));
    } catch { /* the event bus is optional */ }

    this.setDimension(DIM_OVERWORLD);
  }

  // =========================================================================
  // Construction
  // =========================================================================

  _track(...objs) { for (const o of objs) if (o) this._disposables.push(o); }

  _buildDome() {
    const geo = new THREE.SphereGeometry(1, 32, 20);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(0x78a7ff) },
        uHorizon: { value: new THREE.Color(0xc0d8ff) },
        uGround: { value: new THREE.Color(GROUND_TINT) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunHoriz: { value: new THREE.Vector2(1, 0) },
        uGlow: { value: new THREE.Color(0xff9a4d) },
        uGlowAmt: { value: 0 },
        uHalo: { value: 0 },
        uBlend: { value: new THREE.Color(0x000000) },
        uBlendAmt: { value: 0 },
        uSwirl: { value: 0 },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      transparent: false,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.name = 'sky-dome';
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    this.dome.matrixAutoUpdate = false;
    this.dome.updateMatrix();
    this.celestial.add(this.dome);
    this._track(geo, mat);
  }

  _buildStars() {
    const rng = new RNG(0x57a25);
    const pos = new Float32Array(STAR_COUNT * 3);
    const size = new Float32Array(STAR_COUNT);
    const phase = new Float32Array(STAR_COUNT);
    for (let i = 0; i < STAR_COUNT; i++) {
      // Uniform on a sphere: pick z, then an angle.
      const u = rng.float(-1, 1);
      const a = rng.float(0, TAU);
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      pos[i * 3] = Math.cos(a) * r * 0.965;
      pos[i * 3 + 1] = u * 0.965;
      pos[i * 3 + 2] = Math.sin(a) * r * 0.965;
      // A few bright stars carry the eye; the rest are faint.
      size[i] = rng.chance(0.06) ? rng.float(2.6, 4.2) : rng.float(0.9, 2.1);
      phase[i] = rng.float(0, TAU);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.1);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixel: { value: 1 },
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color(0xffffff) },
        uHorizonFade: { value: 1 },
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.stars = new THREE.Points(geo, mat);
    this.stars.name = 'sky-stars';
    this.stars.renderOrder = -900;
    this.stars.frustumCulled = false;
    this.celestial.add(this.stars);
    this._track(geo, mat);
  }

  _buildSunMoon() {
    this.sunTexture = makeSunTexture();
    this.moonTexture = makeMoonTexture();
    this.moonTexture.repeat.set(0.25, 0.5);
    this.moonTexture.offset.set(0, 0.5);

    const sunGeo = new THREE.PlaneGeometry(0.42, 0.42);
    const sunMat = new THREE.MeshBasicMaterial({
      map: this.sunTexture, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
      color: 0xffffff, opacity: 1,
    });
    this.sun = new THREE.Mesh(sunGeo, sunMat);
    this.sun.name = 'sky-sun';
    this.sun.renderOrder = -870;
    this.sun.frustumCulled = false;
    this.celestial.add(this.sun);

    const moonGeo = new THREE.PlaneGeometry(0.20, 0.20);
    const moonMat = new THREE.MeshBasicMaterial({
      map: this.moonTexture, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
      color: 0xdfe6f5, opacity: 1,
    });
    this.moon = new THREE.Mesh(moonGeo, moonMat);
    this.moon.name = 'sky-moon';
    this.moon.renderOrder = -880;
    this.moon.frustumCulled = false;
    this.celestial.add(this.moon);

    this._track(sunGeo, sunMat, moonGeo, moonMat, this.sunTexture, this.moonTexture);
  }

  _buildClouds() {
    this.cloudTexture = makeCloudTexture();
    const geo = new THREE.PlaneGeometry(CLOUD_PLANE, CLOUD_PLANE, 24, 24);
    geo.rotateX(-Math.PI / 2);
    this.cloudGeometry = geo;

    const mk = (shade, order) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: this.cloudTexture },
          uColor: { value: new THREE.Color(0xffffff) },
          uOpacity: { value: 0.82 },
          uShade: { value: shade },
          uUvOffset: { value: new THREE.Vector2(0, 0) },
          uUvScale: { value: 1 / CLOUD_SPAN },
          uFadeStart: { value: 220 },
          uFadeEnd: { value: 520 },
        },
        vertexShader: CLOUD_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = order;
      this._track(mat);
      return m;
    };

    this.cloudsLower = mk(0.72, -20);
    this.cloudsLower.name = 'clouds-lower';
    this.cloudsUpper = mk(1.0, -19);
    this.cloudsUpper.name = 'clouds-upper';
    this.world.add(this.cloudsLower);
    this.world.add(this.cloudsUpper);
    this._track(geo, this.cloudTexture);
  }

  _buildWeather() {
    const mkPrecip = (count, opts) => {
      const geo = instancedQuad(count);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uCenter: { value: new THREE.Vector3() },
          uExtent: { value: new THREE.Vector3(opts.rx, opts.ry, opts.rx) },
          uTime: { value: 0 },
          uFall: { value: opts.fall },
          uSway: { value: opts.sway },
          uWidth: { value: opts.width },
          uStretch: { value: opts.stretch },
          uColor: { value: new THREE.Color(opts.color) },
          uOpacity: { value: 0 },
          uRound: { value: opts.round ? 1 : 0 },
        },
        vertexShader: PRECIP_VERT,
        fragmentShader: PRECIP_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = -10;
      m.visible = false;
      this.world.add(m);
      this._track(geo, mat);
      return m;
    };

    this.rainMesh = mkPrecip(RAIN_DROPS, {
      rx: 30, ry: 22, fall: 26, sway: 0.35, width: 0.055, stretch: 0.85,
      color: 0x9fb8d8, round: false,
    });
    this.rainMesh.name = 'rain';
    this.snowMesh = mkPrecip(SNOW_FLAKES, {
      rx: 26, ry: 20, fall: 3.6, sway: 1.6, width: 0.09, stretch: 0.09,
      color: 0xf2f7ff, round: true,
    });
    this.snowMesh.name = 'snow';

    // --- ground splashes --------------------------------------------------
    const spos = new Float32Array(SPLASH_MAX * 3);
    const slife = new Float32Array(SPLASH_MAX);
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(spos, 3).setUsage(THREE.DynamicDrawUsage));
    sgeo.setAttribute('aLife', new THREE.BufferAttribute(slife, 1).setUsage(THREE.DynamicDrawUsage));
    sgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    sgeo.setDrawRange(0, 0);
    const smat = new THREE.ShaderMaterial({
      uniforms: {
        uPixel: { value: 1 },
        uColor: { value: new THREE.Color(0xb9d2e8) },
        uOpacity: { value: 0.75 },
      },
      vertexShader: SPLASH_VERT,
      fragmentShader: SPLASH_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });
    this.splashPoints = new THREE.Points(sgeo, smat);
    this.splashPoints.name = 'rain-splash';
    this.splashPoints.frustumCulled = false;
    this.splashPoints.renderOrder = -9;
    this.splashPoints.visible = false;
    this.world.add(this.splashPoints);
    this._track(sgeo, smat);

    this._splash = {
      pos: spos,
      life: slife,
      vel: new Float32Array(SPLASH_MAX * 3),
      count: 0,
      geo: sgeo,
      spawnAcc: 0,
      rng: new RNG(0x59148),
    };
  }

  _buildBolt() {
    const verts = BOLT_POINTS * 2;
    const pos = new Float32Array(verts * 3);
    const side = new Float32Array(verts);
    const width = new Float32Array(verts);
    for (let i = 0; i < BOLT_POINTS; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const idx = [];
    for (let i = 0; i < BOLT_POINTS - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, d, a, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('aWidth', new THREE.BufferAttribute(width, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xeef2ff) },
        uOpacity: { value: 1 },
      },
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.boltMesh = new THREE.Mesh(geo, mat);
    this.boltMesh.name = 'lightning';
    this.boltMesh.frustumCulled = false;
    this.boltMesh.renderOrder = -8;
    this.boltMesh.visible = false;
    this.world.add(this.boltMesh);
    this._track(geo, mat);
    this._bolt = { life: 0, rng: new RNG(0xb017) };
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** The colour distant geometry fades into. @returns {THREE.Color} */
  get fogColor() { return this._fogColor; }

  /** Switches palettes and hides the parts a dimension does not have. */
  setDimension(dim) {
    this.dimension = dim || DIM_OVERWORLD;
    const over = this.dimension === DIM_OVERWORLD;
    const end = this.dimension === DIM_END;

    if (this.stars) this.stars.visible = over || end;
    if (this.sun) this.sun.visible = over;
    if (this.moon) this.moon.visible = over;
    if (this.cloudsLower) this.cloudsLower.visible = false;
    if (this.cloudsUpper) this.cloudsUpper.visible = false;
    if (this.rainMesh) this.rainMesh.visible = false;
    if (this.snowMesh) this.snowMesh.visible = false;
    if (this.splashPoints) this.splashPoints.visible = false;
    if (this.boltMesh) this.boltMesh.visible = false;
    if (this._splash) this._splash.count = 0;
    if (this._bolt) this._bolt.life = 0;

    // Snap the smoothed colours so a portal does not cross-fade for a second.
    if (this.dimension === DIM_NETHER) {
      this._biomeFogHex = NETHER_BASE_FOG;
      this._biomeSkyHex = NETHER_BASE_FOG;
      this._fogHex = NETHER_BASE_FOG;
    } else if (end) {
      this._biomeFogHex = END_FOG;
      this._biomeSkyHex = END_ZENITH;
      this._fogHex = END_FOG;
    } else {
      this._biomeFogHex = 0xc0d8ff;
      this._biomeSkyHex = 0x78a7ff;
      this._fogHex = 0xa8c8f0;
    }
    this._fogColor.setHex(this._fogHex);
    this.rain = 0;
    this.thunder = 0;
    this.lightningFlash = 0;
  }

  /** Kicks off a lightning flash and draws a bolt at the strike point. */
  strike(x, y, z) {
    this.lightningFlash = 1;
    if (!this._bolt || !this.boltMesh) return;
    if (this.dimension !== DIM_OVERWORLD) return;
    const geo = this.boltMesh.geometry;
    const pos = geo.getAttribute('position');
    const wid = geo.getAttribute('aWidth');
    const rng = this._bolt.rng;
    const bx = Math.floor(x) + 0.5, bz = Math.floor(z) + 0.5;
    const base = clamp(y, 0, WORLD_HEIGHT);
    const top = CLOUD_Y + 8;
    let cx = bx, cz = bz;
    for (let i = 0; i < BOLT_POINTS; i++) {
      const t = i / (BOLT_POINTS - 1);
      const py = lerp(base, top, t);
      // Jitter grows with height so the bolt splays out towards the cloud.
      const j = 0.5 + t * 4.5;
      cx += rng.float(-j, j) * 0.55;
      cz += rng.float(-j, j) * 0.55;
      cx = lerp(cx, bx, 0.25 * (1 - t));
      cz = lerp(cz, bz, 0.25 * (1 - t));
      const w = lerp(0.45, 0.12, t);
      pos.setXYZ(i * 2, cx, py, cz);
      pos.setXYZ(i * 2 + 1, cx, py, cz);
      wid.setX(i * 2, w);
      wid.setX(i * 2 + 1, w);
    }
    pos.needsUpdate = true;
    wid.needsUpdate = true;
    this._bolt.life = 0.42;
    this.boltMesh.visible = true;
  }

  /**
   * Advances every part of the sky one frame.
   * @param {object} world the active World
   * @param {number} dt seconds since the last frame
   */
  update(world, dt) {
    if (this.disposed || !world || !this.camera) return;
    dt = clamp(Number(dt) || 0, 0, 0.1);
    this._time += dt;
    if (this._time > 100000) this._time -= 100000;

    if (world.dimension && world.dimension !== this.dimension) this.setDimension(world.dimension);

    const cam = this.camera.position;
    const camX = cam.x, camY = cam.y, camZ = cam.z;

    // ---- celestial mechanics -------------------------------------------
    const dayTime = world.time ?? 6000;
    const ca = celestialAngle(dayTime);
    const theta = ca * TAU;
    const day = daylight(theta);
    this.dayFactor = day;
    this.nightFactor = 1 - day;

    // The sun rises in the east (+X) and sets in the west (-X), as in vanilla.
    const sunX = -Math.sin(theta), sunY = Math.cos(theta);
    this.sunDirection.set(sunX, sunY, 0);

    // ---- weather --------------------------------------------------------
    const w = world.weather || { rain: 0, thunder: 0 };
    this.rain = clamp(w.rain || 0, 0, 1);
    this.thunder = clamp(w.thunder || 0, 0, 1);
    if ((world.lightningTicks | 0) > 0) {
      this.lightningFlash = Math.max(this.lightningFlash, clamp(world.lightningTicks / 8, 0, 1));
    }
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 3.2);

    // ---- biome colours (temporally smoothed) ----------------------------
    let biome = null;
    try { biome = world.biomeAt(Math.floor(camX), Math.floor(camZ)); } catch { biome = null; }
    // A biome from the wrong dimension (unloaded column, stale generator) must
    // never repaint the nether blue: fall back to the dimension defaults.
    if (biome && biome.dimension && biome.dimension !== this.dimension) biome = null;
    const targetSky = biome ? (biome.skyColor | 0) : this._biomeSkyHex;
    const targetFog = biome ? (biome.fogColor | 0) : this._biomeFogHex;
    const targetWaterFog = biome
      ? mixHex(mixHex(biome.waterColor | 0, biome.waterFogColor | 0, 0.55), WATER_FOG_TINT, 0.35)
      : this._waterFogHex;
    this._biomeSkyHex = driftHex(this._biomeSkyHex, targetSky, 2.2, dt);
    this._biomeFogHex = driftHex(this._biomeFogHex, targetFog, 2.2, dt);
    this._waterFogHex = driftHex(this._waterFogHex, targetWaterFog, 3, dt);
    this._precip = biome ? (biome.precipitation || 'rain') : 'rain';

    this._updateSkyColors(world, theta, day, camY);
    this._updateCelestial(world, dt, cam);
    this._updateFog(world, camX, camY, camZ, day);
    this._updateClouds(world, dt, cam);
    this._updateWeather(world, dt, cam);
    this._updateBolt(dt);
    this._applyFog();
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /** Zenith / horizon / glow for the dome, and the base fog colour. */
  _updateSkyColors(world, theta, day, camY) {
    const dim = this.dimension;
    const flash = this.lightningFlash;
    const wet = clamp(this.rain * 0.65 + this.thunder * 0.35, 0, 1);
    let zenith, horizon, ground, swirl = 0, glowAmt = 0, halo = 0;
    let glowHex = 0xff9a4d;

    if (dim === DIM_NETHER) {
      // No sky at all - just the dimension's dark red haze.
      zenith = this._biomeFogHex;
      horizon = scaleHex(this._biomeFogHex, 1.25);
      ground = scaleHex(this._biomeFogHex, 0.6);
      this._fogHex = this._biomeFogHex;
    } else if (dim === DIM_END) {
      zenith = END_ZENITH;
      horizon = mixHex(END_HORIZON, this._biomeFogHex, 0.13);
      ground = 0x060409;
      swirl = 1;
      this._fogHex = scaleHex(this._biomeFogHex, 0.34);
    } else {
      // Overworld: biome colour, dimmed towards the night floor.
      const skyLit = scaleHex(this._biomeSkyHex, clamp(day * 1.05, 0, 1));
      const fogLit = scaleHex(this._biomeFogHex, clamp(day * 1.05, 0, 1));
      zenith = mixHex(NIGHT_ZENITH, skyLit, clamp(day * 1.1, 0, 1));
      horizon = mixHex(NIGHT_HORIZON, fogLit, clamp(day * 1.1, 0, 1));
      ground = mixHex(GROUND_TINT, scaleHex(horizon, 0.55), day);

      // Rain flattens and greys the sky.
      if (wet > 0) {
        const grey = scaleHex(0x8c98a8, 0.35 + day * 0.65);
        zenith = mixHex(zenith, scaleHex(grey, 0.7), wet * 0.75);
        horizon = mixHex(horizon, grey, wet * 0.8);
      }

      glowAmt = sunriseGlow(theta, this._glow) * (1 - wet * 0.75);
      glowHex = this._glow.hex;
      halo = day * 0.55 * (1 - wet * 0.85);
      this._fogHex = horizon;
      if (glowAmt > 0) this._fogHex = mixHex(this._fogHex, glowHex, glowAmt * 0.34);
    }

    // Lightning briefly whites out the whole sky.
    if (flash > 0.001) {
      const k = flash * 0.55;
      zenith = mixHex(zenith, 0xbfcfe8, k);
      horizon = mixHex(horizon, 0xd6e2f2, k);
      this._fogHex = mixHex(this._fogHex, 0xc8d6ea, k * 0.8);
    }

    // Void fog: below bedrock the world simply stops existing.
    if (dim !== DIM_NETHER && camY < 0) {
      const v = clamp(-camY / 14, 0, 1);
      zenith = mixHex(zenith, 0x000000, v);
      horizon = mixHex(horizon, 0x000000, v);
      ground = mixHex(ground, 0x000000, v);
      this._fogHex = mixHex(this._fogHex, 0x000000, v);
      this._voidFactor = v;
    } else {
      this._voidFactor = 0;
    }

    this.skyTopColor.setHex(zenith);
    this.skyHorizonColor.setHex(horizon);

    const u = this.dome && this.dome.material && this.dome.material.uniforms;
    if (u) {
      u.uZenith.value.setHex(zenith);
      u.uHorizon.value.setHex(horizon);
      u.uGround.value.setHex(ground);
      u.uGlow.value.setHex(glowHex);
      u.uGlowAmt.value = glowAmt;
      u.uHalo.value = halo;
      u.uSwirl.value = swirl;
      u.uSunDir.value.copy(this.sunDirection);
      const hx = this.sunDirection.x, hz = this.sunDirection.z;
      const hl = Math.hypot(hx, hz);
      if (hl > 1e-4) u.uSunHoriz.value.set(hx / hl, hz / hl);
    }
  }

  /** Places the celestial group, the sun, the moon and the star field. */
  _updateCelestial(world, dt, cam) {
    const camera = this.camera;
    // Everything lives in a unit sphere scaled out to just inside the far
    // plane, so it depth-tests correctly against terrain but never clips.
    const R = Math.max(64, Math.min((camera.far || 1200) * 0.8, 1000));
    this.celestial.position.copy(cam);
    this.celestial.scale.setScalar(R);
    this.celestial.updateMatrix();
    this.celestial.updateMatrixWorld(true);

    const submerged = this.submerged !== 'none';
    const wet = clamp(this.rain * 0.9 + this.thunder * 0.1, 0, 1);
    const dim = this.dimension;

    // ---- stars ----------------------------------------------------------
    if (this.stars) {
      const su = this.stars.material.uniforms;
      su.uTime.value = this._time;
      let pr = 1;
      try { pr = Game.renderer ? Game.renderer.getPixelRatio() : 1; } catch { pr = 1; }
      su.uPixel.value = clamp(pr, 0.5, 3);
      if (dim === DIM_END) {
        su.uOpacity.value = 0.85;
        su.uColor.value.setHex(0xd6c8ff);
        su.uHorizonFade.value = 0;
        this.stars.visible = !submerged;
      } else if (dim === DIM_OVERWORLD) {
        // Vanilla's star brightness curve: nothing in daylight, full at night.
        const b = clamp(1 - this.dayFactor * 1.35, 0, 1);
        const vis = b * b * (1 - wet * 0.9) * (1 - (this._voidFactor || 0));
        su.uOpacity.value = vis;
        su.uColor.value.setHex(0xffffff);
        su.uHorizonFade.value = 1;
        this.stars.visible = vis > 0.01 && !submerged;
      } else {
        this.stars.visible = false;
      }
    }

    if (dim !== DIM_OVERWORLD) {
      if (this.sun) this.sun.visible = false;
      if (this.moon) this.moon.visible = false;
      return;
    }

    const fade = (1 - wet * 0.8) * (1 - (this._voidFactor || 0));

    // ---- sun ------------------------------------------------------------
    if (this.sun) {
      const d = this.sunDirection;
      this.sun.position.set(d.x * 0.82, d.y * 0.82, d.z * 0.82);
      this._v3.set(-d.x, -d.y, -d.z).normalize();
      this._quat.setFromUnitVectors(this._forward, this._v3);
      this.sun.quaternion.copy(this._quat);
      // Warm and swollen near the horizon, small and white overhead.
      const low = clamp(1 - Math.abs(d.y) * 2.2, 0, 1);
      const s = lerp(1, 1.35, low);
      this.sun.scale.set(s, s, 1);
      this.sun.material.color.setHex(mixHex(0xffffff, 0xff9a44, low * 0.8));
      this.sun.material.opacity = clamp((d.y + 0.16) * 4, 0, 1) * fade;
      this.sun.visible = this.sun.material.opacity > 0.01 && this.submerged === 'none';
    }

    // ---- moon -----------------------------------------------------------
    if (this.moon) {
      const d = this.sunDirection;
      this.moon.position.set(-d.x * 0.82, -d.y * 0.82, -d.z * 0.82);
      this._v3.set(d.x, d.y, d.z).normalize();
      this._quat.setFromUnitVectors(this._forward, this._v3);
      this.moon.quaternion.copy(this._quat);
      const phase = Math.floor(((world.totalTime || 0) / 24000)) % 8;
      const p = ((phase % 8) + 8) % 8;
      if (p !== this.moonPhase) {
        this.moonPhase = p;
        const col = p % 4, row = (p / 4) | 0;
        this.moonTexture.offset.set(col * 0.25, 1 - (row + 1) * 0.5);
      }
      this.moon.material.opacity = clamp((-d.y + 0.16) * 4, 0, 1) * fade;
      this.moon.visible = this.moon.material.opacity > 0.01 && this.submerged === 'none';
    }
  }

  /**
   * Blends the fog colour from biome, time, weather and dimension, then
   * derives near/far from the render distance and whatever the camera is
   * standing in.
   */
  _updateFog(world, camX, camY, camZ, day) {
    const dim = this.dimension;
    const rd = renderDistance();
    let far = Math.max(32, rd * CHUNK_X * 0.95);
    let near = far * 0.62;
    let hex = this._fogHex;
    let density = 0;

    if (dim === DIM_NETHER) {
      // The nether is a permanently hazy room.
      far = Math.min(far, Math.max(24, rd * CHUNK_X * 0.55));
      near = far * 0.24;
      density = 0.35;
    } else if (dim === DIM_END) {
      far = Math.min(far, Math.max(40, rd * CHUNK_X * 0.85));
      near = far * 0.28;
      density = 0.2;
    } else {
      const wet = clamp(this.rain * 0.7 + this.thunder * 0.3, 0, 1);
      // Night pulls the horizon in a little; noon pushes it out.
      far *= (1 - wet * 0.36) * lerp(0.86, 1.0, day);
      // Clear weather keeps the haze in the last fifth of the view distance.
      // Starting it at 0.62 turned most of the visible world white.
      near = far * lerp(0.82, 0.30, wet);
      density = wet * 0.35;
    }

    // ---- what is the camera standing in? --------------------------------
    const bd = defAt(world, camX, camY, camZ);
    const liquid = bd ? bd.liquid : null;
    let medium = 'none';
    if (liquid === 'water') medium = 'water';
    else if (liquid === 'lava') medium = 'lava';
    else if (bd && bd.name === 'powder_snow') medium = 'powder_snow';
    this.submerged = medium;

    const player = Game.player;
    const hasEffect = (n) => {
      try { return !!(player && player.hasEffect && player.hasEffect(n)); } catch { return false; }
    };

    let blendHex = hex;
    let blendAmt = 0;

    if (medium === 'water') {
      hex = this._waterFogHex;
      near = 0.4;
      far = hasEffect('water_breathing') ? 22 : 14;
      density = 0.8;
      blendHex = hex; blendAmt = 1;
    } else if (medium === 'lava') {
      hex = LAVA_FOG;
      near = 0.05;
      far = hasEffect('fire_resistance') ? 5.5 : 1.6;
      density = 0.98;
      blendHex = hex; blendAmt = 1;
    } else if (medium === 'powder_snow') {
      hex = SNOW_FOG;
      near = 0.05;
      far = 1.8;
      density = 0.96;
      blendHex = hex; blendAmt = 1;
    } else {
      // Void fog: everything below the world closes in and goes black.
      const v = this._voidFactor || 0;
      if (v > 0) {
        far = lerp(far, 10, v);
        near = lerp(near, 0, v);
        density = Math.max(density, v * 0.7);
        blendHex = 0x000000; blendAmt = v * 0.85;
      }
    }

    // ---- status effects --------------------------------------------------
    if (hasEffect('blindness')) {
      let k = 1;
      try {
        const e = player.getEffect('blindness');
        // Ease out over the last second so it does not pop.
        if (e && typeof e.ticks === 'number') k = clamp(e.ticks / 20, 0, 1);
      } catch { k = 1; }
      far = Math.min(far, lerp(far, 5, k));
      near = Math.min(near, far * 0.05);
      density = Math.max(density, k * 0.9);
      hex = mixHex(hex, 0x000000, k * 0.85);
      blendHex = mixHex(blendHex, 0x000000, k * 0.85);
      blendAmt = Math.max(blendAmt, k * 0.85);
    }
    if (hasEffect('darkness')) {
      // Vanilla's darkness pulses on a ~1s cycle.
      const pulse = 0.5 + 0.5 * Math.cos(this._time * 3.1);
      const shrink = lerp(0.35, 1, pulse);
      far = Math.min(far, 18 * shrink);
      near = Math.min(near, far * 0.1);
      density = Math.max(density, 0.6);
      hex = mixHex(hex, 0x050508, 0.7);
      blendHex = mixHex(blendHex, 0x050508, 0.7);
      blendAmt = Math.max(blendAmt, 0.7);
    }

    // Brightness ("moody" .. "bright") lifts the fog colour a touch.
    const bright = clamp(Number(setting('brightness', 0.5)) || 0, 0, 1);
    if (bright !== 0.5) hex = scaleHex(hex, lerp(0.82, 1.18, bright));

    if (far <= near + 0.1) near = Math.max(0, far - 0.1);

    this.fogNear = near;
    this.fogFar = far;
    this.fogDensity = clamp(density, 0, 1);
    this._fogColor.setHex(hex);
    this._fogHex = hex;

    const u = this.dome && this.dome.material && this.dome.material.uniforms;
    if (u) {
      u.uBlend.value.setHex(blendHex);
      u.uBlendAmt.value = clamp(blendAmt, 0, 1);
    }
  }

  /** Writes our numbers into the scene fog and the clear colour. */
  _applyFog() {
    const fog = this.scene ? this.scene.fog : null;
    if (fog) {
      if (fog.color) fog.color.copy(this._fogColor);
      if (typeof fog.near === 'number') { fog.near = this.fogNear; fog.far = this.fogFar; }
      else if (typeof fog.density === 'number') fog.density = 1.6 / Math.max(1, this.fogFar);
    }
    try {
      if (Game.renderer) Game.renderer.setClearColor(this._fogColor, 1);
    } catch { /* the renderer is not ours to insist on */ }
  }

  /** Scrolls the cloud sheet and keeps it centred on the camera. */
  _updateClouds(world, dt, cam) {
    if (!this.cloudsLower || !this.cloudsUpper) return;
    const on = this.dimension === DIM_OVERWORLD
      && !!setting('clouds', true)
      && this.submerged === 'none';
    if (!on) {
      if (this.cloudsLower) this.cloudsLower.visible = false;
      if (this.cloudsUpper) this.cloudsUpper.visible = false;
      return;
    }
    if (!this._anisoDone) {
      this._anisoDone = true;
      try {
        const max = Game.renderer ? Game.renderer.capabilities.getMaxAnisotropy() : 1;
        if (max > 1) { this.cloudTexture.anisotropy = Math.min(8, max); this.cloudTexture.needsUpdate = true; }
      } catch { /* no renderer yet is fine */ }
    }
    const fancy = !!setting('fancyGraphics', true);
    const rd = renderDistance();
    const camFar = (this.camera.far || 1200) * 0.92;
    const fadeEnd = clamp(rd * CHUNK_X * 3.2, 240, Math.min(camFar, CLOUD_PLANE * 0.45));
    const fadeStart = fadeEnd * 0.45;

    // Vanilla drifts clouds along +X at 0.03 blocks per tick.
    const scroll = this._time * CLOUD_SPEED;
    const wet = clamp(this.rain * 0.8 + this.thunder * 0.2, 0, 1);

    // Clouds take the horizon colour so they never fight the sky.
    const lit = clamp(this.dayFactor * 1.15, 0, 1);
    let tint = scaleHex(0xffffff, lerp(0.17, 1.0, lit));
    tint = mixHex(tint, this._fogHex, 0.32);
    if (wet > 0) tint = mixHex(tint, 0x6e7684, wet * 0.6);
    if (this.lightningFlash > 0.001) tint = mixHex(tint, 0xffffff, this.lightningFlash * 0.7);

    const opacity = lerp(0.78, 0.92, wet) * (1 - (this._voidFactor || 0));

    const setLayer = (mesh, y, parallax, shade) => {
      mesh.position.set(cam.x, y, cam.z);
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
      const u = mesh.material.uniforms;
      u.uUvOffset.value.set(scroll + parallax, parallax * 0.35);
      u.uColor.value.setHex(tint);
      u.uOpacity.value = opacity;
      u.uShade.value = shade;
      u.uFadeStart.value = fadeStart;
      u.uFadeEnd.value = fadeEnd;
      mesh.visible = true;
    };

    if (fancy) {
      // Two offset sheets read as a slab with a shaded underside.
      const par = clamp((cam.y - (CLOUD_Y + CLOUD_THICKNESS * 0.5)) * 0.09, -14, 14);
      setLayer(this.cloudsLower, CLOUD_Y, par, 0.74);
      setLayer(this.cloudsUpper, CLOUD_Y + CLOUD_THICKNESS, -par, 1.0);
      this.cloudsLower.visible = true;
      this.cloudsUpper.visible = true;
    } else {
      setLayer(this.cloudsUpper, CLOUD_Y + CLOUD_THICKNESS * 0.5, 0, 0.94);
      this.cloudsLower.visible = false;
      this.cloudsUpper.visible = true;
    }
  }

  /** Rain / snow sheets, ground splashes and the roof check. */
  _updateWeather(world, dt, cam) {
    const rain = this.rainMesh, snow = this.snowMesh;
    if (!rain || !snow) return;

    const active = this.dimension === DIM_OVERWORLD
      && this.rain > 0.02
      && this.submerged === 'none'
      && this._precip !== 'none';

    if (!active) {
      rain.visible = false;
      snow.visible = false;
      if (this.splashPoints) {
        this._stepSplashes(dt, cam, 0, world);
        this.splashPoints.visible = this._splash.count > 0;
      }
      return;
    }

    // Under a roof the sheet thins out instead of vanishing, which reads much
    // better than a hard cut when you run into a cave mouth.
    let outdoors = 1;
    try {
      outdoors = world.canSeeSky(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z)) ? 1 : 0.12;
    } catch { outdoors = 1; }
    this._roofFade = lerp(this._roofFade, outdoors, clamp(dt * 4, 0, 1));

    const snowy = this._precip === 'snow';
    const strength = clamp(this.rain, 0, 1) * this._roofFade;
    const stormy = clamp(this.thunder, 0, 1);

    const mesh = snowy ? snow : rain;
    const other = snowy ? rain : snow;
    other.visible = false;

    const u = mesh.material.uniforms;
    u.uTime.value = this._time % 600;
    u.uCenter.value.set(cam.x, cam.y + (snowy ? 2 : 3), cam.z);
    u.uOpacity.value = (snowy ? 0.85 : 0.62) * strength;
    if (!snowy) {
      u.uFall.value = 26 + stormy * 10;
      u.uStretch.value = 0.85 + stormy * 0.35;
      u.uColor.value.setHex(mixHex(0x9fb8d8, 0x76889f, stormy * 0.6));
    } else {
      u.uFall.value = 3.4 + stormy * 1.2;
      u.uSway.value = 1.4 + stormy * 0.9;
    }
    mesh.visible = strength > 0.02;

    // ---- splashes -------------------------------------------------------
    const rate = snowy ? 0 : 90 * strength;
    this._stepSplashes(dt, cam, rate, world);
    if (this.splashPoints) {
      this.splashPoints.visible = this._splash.count > 0;
      this.splashPoints.material.uniforms.uOpacity.value = 0.7 * strength;
      let pr = 1;
      try { pr = Game.renderer ? Game.renderer.getPixelRatio() : 1; } catch { pr = 1; }
      this.splashPoints.material.uniforms.uPixel.value = clamp(pr, 0.5, 3);
    }
  }

  /** Integrates the little water bounces that land around the player. */
  _stepSplashes(dt, cam, spawnRate, world) {
    const s = this._splash;
    if (!s) return;
    const pos = s.pos, vel = s.vel, life = s.life;

    // --- spawn ---
    s.spawnAcc += spawnRate * dt;
    let budget = Math.min(24, Math.floor(s.spawnAcc));
    s.spawnAcc -= budget;
    while (budget-- > 0 && s.count < SPLASH_MAX) {
      const a = s.rng.float(0, TAU);
      const r = Math.sqrt(s.rng.next()) * 12;
      const x = cam.x + Math.cos(a) * r;
      const z = cam.z + Math.sin(a) * r;
      let y = -1;
      try { y = world.getTopSolid(Math.floor(x), Math.floor(z)); } catch { y = -1; }
      if (y < 0 || y > WORLD_HEIGHT - 1) continue;
      const sy = y + 1.02;
      if (Math.abs(sy - cam.y) > 16) continue;
      try {
        if (!world.canSeeSky(Math.floor(x), Math.floor(sy), Math.floor(z))) continue;
      } catch { /* unloaded columns are open sky */ }
      const i = s.count++;
      pos[i * 3] = x; pos[i * 3 + 1] = sy; pos[i * 3 + 2] = z;
      vel[i * 3] = s.rng.float(-0.5, 0.5);
      vel[i * 3 + 1] = s.rng.float(1.2, 2.8);
      vel[i * 3 + 2] = s.rng.float(-0.5, 0.5);
      life[i] = 1;
    }

    // --- integrate + compact ---
    let n = s.count;
    for (let i = 0; i < n; i++) {
      life[i] -= dt * 3.6;
      if (life[i] <= 0) {
        const last = --n;
        if (i !== last) {
          pos[i * 3] = pos[last * 3]; pos[i * 3 + 1] = pos[last * 3 + 1]; pos[i * 3 + 2] = pos[last * 3 + 2];
          vel[i * 3] = vel[last * 3]; vel[i * 3 + 1] = vel[last * 3 + 1]; vel[i * 3 + 2] = vel[last * 3 + 2];
          life[i] = life[last];
        }
        i--;
        continue;
      }
      vel[i * 3 + 1] -= 9.0 * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    }
    s.count = n;

    const geo = s.geo;
    geo.setDrawRange(0, n);
    if (n > 0) {
      geo.getAttribute('position').needsUpdate = true;
      geo.getAttribute('aLife').needsUpdate = true;
    }
  }

  /** Flickers and retires the current lightning bolt. */
  _updateBolt(dt) {
    const b = this._bolt;
    if (!b || !this.boltMesh) return;
    if (b.life <= 0) {
      if (this.boltMesh.visible) this.boltMesh.visible = false;
      return;
    }
    b.life -= dt;
    if (b.life <= 0) { this.boltMesh.visible = false; return; }
    // Two quick strobes then a fade, like the vanilla bolt.
    const t = b.life / 0.42;
    const strobe = t > 0.72 ? 1 : (Math.sin(t * 46) > -0.2 ? 1 : 0.15);
    this.boltMesh.material.uniforms.uOpacity.value = clamp(t * 1.4, 0, 1) * strobe;
    this.boltMesh.visible = true;
  }

  // =========================================================================
  // Teardown
  // =========================================================================

  /** Releases every GPU resource this module created. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try { if (this._offLightning) this._offLightning(); } catch { /* already gone */ }
    this._offLightning = null;

    if (this.scene) {
      this.scene.remove(this.celestial);
      this.scene.remove(this.world);
      if (this._ownsFog && this.scene.fog === this._fog) this.scene.fog = null;
    }
    for (const d of this._disposables) {
      try { if (d && typeof d.dispose === 'function') d.dispose(); } catch { /* best effort */ }
    }
    this._disposables.length = 0;
    this.dome = this.stars = this.sun = this.moon = null;
    this.cloudsLower = this.cloudsUpper = null;
    this.rainMesh = this.snowMesh = this.splashPoints = this.boltMesh = null;
  }
}

export default Sky;
