// ============================================================================
// models.js - Entity box models + animation (CONTRACT.md section 15).
//
// Coordinate system
// -----------------
//  * One model unit = 1/16 block, exactly like Minecraft's model files.
//  * `pivot` is Y-UP with the origin at the entity's feet. A humanoid neck is
//    therefore [0, 24, 0]. For a child part the pivot is relative to its
//    parent's pivot (still Y-up).
//  * `pos`/`size` inside a box are copied verbatim from Minecraft's model
//    sources, i.e. Y-DOWN relative to the pivot. The standard head box
//    `pos [-4,-8,-4] size [8,8,8]` on pivot [0,24,0] spans y 24..32.
//    Converting a vanilla ModelRenderer is mechanical:
//        pivot = [mcX, 24 - mcY, mcZ]      rot = [-mcRotX, mcRotY, -mcRotZ]
//  * The model faces -Z. Its right-hand side is +X, so a group whose
//    `rotation.y` equals the entity yaw of a `(-sin y, 0, -cos y)` forward
//    vector points the model the right way with no extra fudge.
//
// UV unwrap
// ---------
// Boxes are unwrapped in the classic Minecraft layout. For a box of size
// (w,h,d) whose uv origin is (u,v):
//     right  (u,           v+d, d, h)      front (u+d,       v+d, w, h)
//     left   (u+d+w,       v+d, d, h)      back  (u+d+w+d,   v+d, w, h)
//     top    (u+d,         v,   w, d)      bottom(u+d+w,     v,   w, d)
// `usize` overrides the (w,h,d) used for that computation so an oversized box
// can still sample a canonically painted rectangle of the 64x64 skin sheet.
//
// Materials
// ---------
// MeshBasicMaterial: the rest of the renderer is unlit (chunkrenderer uses
// vertex colours), so a Lambert material would render pitch black in a scene
// with no lights. Minecraft's per-face directional shading is baked into the
// geometry's vertex colours instead, which reproduces the same look and lets
// entityrenderer tint a whole entity by block light with `inst.setLight()`.
// ============================================================================
import * as THREE from 'three';
import { getSkinTexture } from './skins.js';
import { clamp, angleDiff } from '../core/util.js';

const S = 1 / 16;
const PI = Math.PI;
const HALF_PI = PI / 2;
const sin = Math.sin;
const cos = Math.cos;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// n = outward normal, u = texture +u direction, v = texture "up" direction.
// Chosen so that u x v === n, which makes the TL,BL,BR,TR winding front-facing.
const FACE_DEF = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },   // +X  character's right
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },   // -X  character's left
  { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },   // +Y  top
  { n: [0, -1, 0], u: [-1, 0, 0], v: [0, 0, -1] }, // -Y  bottom
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },  // -Z  front
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },    // +Z  back
];
// Same directional shading the chunk mesher uses, baked per face.
const FACE_SHADE = [0.62, 0.62, 1.0, 0.5, 0.86, 0.86];
const CORNER = [[-1, 1], [-1, -1], [1, -1], [1, 1]];   // TL, BL, BR, TR

/** Pixel rectangles for the six faces of a box in the vanilla unwrap order. */
function faceRects(w, h, d, u, v, mirror) {
  const r = [
    [u, v + d, d, h],                 // +X
    [u + d + w, v + d, d, h],         // -X
    [u + d, v, w, d],                 // +Y
    [u + d + w, v, w, d],             // -Y
    [u + d, v + d, w, h],             // -Z
    [u + d + w + d, v + d, w, h],     // +Z
  ];
  if (mirror) { const t = r[0]; r[0] = r[1]; r[1] = t; }
  return r;
}

/**
 * Builds one BufferGeometry holding every box of a part, with vanilla UVs.
 * @param {Array} boxes box descriptors
 * @param {number} texW skin width in pixels
 * @param {number} texH skin height in pixels
 * @param {boolean} flipY true when the texture's flipY is on
 * @param {boolean} bright skip directional shading (glowing parts)
 * @returns {THREE.BufferGeometry}
 */
function buildGeometry(boxes, texW, texH, flipY, bright) {
  const n = boxes.length;
  const position = new Float32Array(n * 72);
  const normal = new Float32Array(n * 72);
  const color = new Float32Array(n * 72);
  const uvArr = new Float32Array(n * 48);
  const index = new Uint16Array(n * 36);
  let vi = 0, ui = 0, ii = 0, base = 0;
  for (let bi = 0; bi < n; bi++) {
    const b = boxes[bi];
    const inf = b.inflate || 0;
    const w = b.size[0], h = b.size[1], d = b.size[2];
    const x0 = (b.pos[0] - inf) * S, x1 = (b.pos[0] + w + inf) * S;
    const y0 = (-(b.pos[1] + h) - inf) * S, y1 = (-b.pos[1] + inf) * S;
    const z0 = (b.pos[2] - inf) * S, z1 = (b.pos[2] + d + inf) * S;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const ex = (x1 - x0) / 2, ey = (y1 - y0) / 2, ez = (z1 - z0) / 2;
    const us = b.usize;
    const rects = faceRects(us ? us[0] : w, us ? us[1] : h, us ? us[2] : d,
      b.uv[0], b.uv[1], b.mirror);
    const glow = bright || b.bright;
    for (let f = 0; f < 6; f++) {
      const F = FACE_DEF[f], r = rects[f];
      const hu = F.u[0] ? ex : (F.u[1] ? ey : ez);
      const hv = F.v[0] ? ex : (F.v[1] ? ey : ez);
      const shade = glow ? 1 : FACE_SHADE[f];
      const insU = r[2] === 0 ? 0 : 0.016, insV = r[3] === 0 ? 0 : 0.016;
      let pu0 = r[0] + insU, pu1 = r[0] + r[2] - insU;
      const pv0 = r[1] + insV, pv1 = r[1] + r[3] - insV;
      if (b.mirror) { const t = pu0; pu0 = pu1; pu1 = t; }
      const uvc = [[pu0, pv0], [pu0, pv1], [pu1, pv1], [pu1, pv0]];
      for (let k = 0; k < 4; k++) {
        const su = CORNER[k][0], sv = CORNER[k][1];
        position[vi] = cx + F.n[0] * ex + F.u[0] * hu * su + F.v[0] * hv * sv;
        position[vi + 1] = cy + F.n[1] * ey + F.u[1] * hu * su + F.v[1] * hv * sv;
        position[vi + 2] = cz + F.n[2] * ez + F.u[2] * hu * su + F.v[2] * hv * sv;
        normal[vi] = F.n[0]; normal[vi + 1] = F.n[1]; normal[vi + 2] = F.n[2];
        color[vi] = shade; color[vi + 1] = shade; color[vi + 2] = shade;
        vi += 3;
        uvArr[ui] = uvc[k][0] / texW;
        uvArr[ui + 1] = flipY ? 1 - uvc[k][1] / texH : uvc[k][1] / texH;
        ui += 2;
      }
      index[ii++] = base; index[ii++] = base + 1; index[ii++] = base + 2;
      index[ii++] = base; index[ii++] = base + 2; index[ii++] = base + 3;
      base += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingSphere();
  return g;
}

// Geometry is immutable per (model, part) so every instance shares it.
const GEO_CACHE = new Map();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** name -> ModelDef. */
export const MODELS = {};
/** Every registered model name, in registration order. */
export const MODEL_NAMES = [];

/**
 * Registers a model definition.
 * @param {string} name canonical name, e.g. 'zombie'
 * @param {object} def { texWidth, texHeight, scale, skin, parts, animate, baby }
 * @returns {object} the stored definition
 */
export function defineModel(name, def) {
  if (!MODELS[name]) MODEL_NAMES.push(name);
  def.name = name;
  if (def.texWidth === undefined) def.texWidth = 64;
  if (def.texHeight === undefined) def.texHeight = 64;
  if (def.scale === undefined) def.scale = 1;
  if (!def.parts) def.parts = [];
  MODELS[name] = def;
  GEO_CACHE.forEach((_, k) => { if (k.startsWith(name + '|')) GEO_CACHE.delete(k); });
  return def;
}

// Shorthand used by every definition below.
const bx = (x, y, z, w, h, d, u, v, inflate) =>
  ({ pos: [x, y, z], size: [w, h, d], uv: [u, v], inflate: inflate || 0 });
/** Same, but the uv rectangle is sized as if the box were `uw,uh,ud`. */
const bxu = (x, y, z, w, h, d, u, v, uw, uh, ud, inflate) =>
  ({ pos: [x, y, z], size: [w, h, d], uv: [u, v], usize: [uw, uh, ud], inflate: inflate || 0 });
const P = (name, px, py, pz, boxes, extra) =>
  Object.assign({ name, pivot: [px, py, pz], boxes: boxes || [] }, extra || null);

// ---------------------------------------------------------------------------
// Instantiation
// ---------------------------------------------------------------------------

function makeMaterial(tex, alpha) {
  return new THREE.MeshBasicMaterial({
    map: tex,
    vertexColors: true,
    side: THREE.FrontSide,
    alphaTest: alpha ? 0.5 : 0.08,
    transparent: false,
    fog: true,
  });
}

const WHITE_TEX = { value: null };
function fallbackTexture() {
  if (WHITE_TEX.value) return WHITE_TEX.value;
  const data = new Uint8Array([255, 255, 255, 255]);
  const t = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  WHITE_TEX.value = t;
  return t;
}

function skinTexture(name) {
  try {
    const t = getSkinTexture(name);
    if (t) return t;
  } catch (err) {
    console.warn('[models] no skin "' + name + '"', err);
  }
  return fallbackTexture();
}

function buildPart(def, parent, ctx, path) {
  const key = ctx.key + '|' + path;
  let geo = GEO_CACHE.get(key);
  if (geo === undefined) {
    geo = (def.boxes && def.boxes.length)
      ? buildGeometry(def.boxes, ctx.tw, ctx.th, ctx.flipY, def.bright)
      : null;
    GEO_CACHE.set(key, geo);
  }
  let obj;
  if (geo) {
    obj = new THREE.Mesh(geo, def.alpha ? ctx.alphaMat : ctx.baseMat);
    obj.frustumCulled = false;
  } else {
    obj = new THREE.Group();
  }
  obj.name = def.name;
  obj.position.set(def.pivot[0] * S, def.pivot[1] * S, def.pivot[2] * S);
  if (def.rot) obj.rotation.set(def.rot[0] || 0, def.rot[1] || 0, def.rot[2] || 0);
  if (def.scale) obj.scale.setScalar(def.scale);
  if (def.visible === false) obj.visible = false;
  parent.add(obj);
  ctx.parts[def.name] = obj;
  ctx.rest.push({
    o: obj,
    px: obj.position.x, py: obj.position.y, pz: obj.position.z,
    rx: obj.rotation.x, ry: obj.rotation.y, rz: obj.rotation.z,
    s: obj.scale.x, vis: obj.visible,
  });
  if (def.children) {
    for (let i = 0; i < def.children.length; i++) buildPart(def.children[i], obj, ctx, path + '.' + i);
  }
  return obj;
}

/**
 * Instantiates a model.
 * @param {string} name model name (an unknown name is resolved with modelForMob)
 * @param {string} [skinName] skin to sample; defaults to the model's own skin
 * @returns {{group: THREE.Group, parts: Record<string, THREE.Object3D>}} instance
 */
export function buildModel(name, skinName) {
  const key = MODELS[name] ? name : modelForMob(name);
  const def = MODELS[key] || MODELS.humanoid;
  const skin = skinName || def.skin || name || key;
  const tex = skinTexture(skin);
  const baseMat = makeMaterial(tex, false);
  const alphaMat = makeMaterial(tex, true);
  const group = new THREE.Group();
  group.name = key;
  const root = new THREE.Group();
  root.name = '__root';
  root.scale.setScalar(def.scale);
  group.add(root);
  const ctx = {
    key: def.name + '|' + (tex.flipY ? 1 : 0),
    tw: def.texWidth, th: def.texHeight, flipY: !!tex.flipY,
    baseMat, alphaMat, parts: Object.create(null), rest: [],
  };
  for (let i = 0; i < def.parts.length; i++) buildPart(def.parts[i], root, ctx, String(i));
  const inst = {
    name: key, skin, def, group, root,
    parts: ctx.parts, rest: ctx.rest,
    materials: [baseMat, alphaMat],
    t: null, _ls: 0, _la: 0, _lastAge: null, _tint: -1, _err: false,
    /** Multiplies the whole model by a 0..1 block-light brightness. */
    setLight(v) {
      const c = clamp(v, 0, 1);
      baseMat.color.setRGB(c, c, c);
      alphaMat.color.setRGB(c, c, c);
    },
  };
  return inst;
}

/**
 * Releases the per-instance materials and unhooks the group from the scene.
 * Geometry is shared between instances and deliberately kept in the cache.
 * @param {object} inst instance returned by buildModel
 */
export function disposeModel(inst) {
  if (!inst) return;
  if (inst.group && inst.group.parent) inst.group.parent.remove(inst.group);
  if (inst.materials) for (const m of inst.materials) m.dispose();
  if (inst.group) inst.group.clear();
  inst.parts = Object.create(null);
  inst.rest = [];
  inst.materials = [];
}

/** Frees every cached geometry. Only useful when tearing the renderer down. */
export function disposeModelCache() {
  GEO_CACHE.forEach((g) => { if (g) g.dispose(); });
  GEO_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Animation driver
// ---------------------------------------------------------------------------

const EMPTY_ENTITY = {};
const DEFAULT_BABY = { bodyScale: 0.5, headScale: 1.5, headOffsetY: 0, head: ['head', 'hat'] };

/**
 * Poses one instance for this frame: resets to the rest pose, runs the model's
 * own animation, then layers hurt tilt, death roll and baby scaling on top.
 * @param {object} inst instance from buildModel
 * @param {object} entity the entity being rendered
 * @param {number} partialTicks 0..1 interpolation inside the current tick
 */
export function animateModel(inst, entity, partialTicks = 0) {
  if (!inst || !inst.def) return;
  const e = entity || EMPTY_ENTITY;
  const def = inst.def;

  // --- reset to rest pose -------------------------------------------------
  const rest = inst.rest;
  for (let i = 0; i < rest.length; i++) {
    const r = rest[i], o = r.o;
    o.position.set(r.px, r.py, r.pz);
    o.rotation.set(r.rx, r.ry, r.rz);
    o.scale.setScalar(r.s);
    o.visible = r.vis;
  }
  inst.root.position.set(0, 0, 0);
  inst.root.rotation.set(0, 0, 0);
  inst.root.scale.setScalar(def.scale);

  // --- build the animation context ----------------------------------------
  const pt = clamp(partialTicks || 0, 0, 1);
  const age = (e.age || 0) + pt;
  const t = inst.t || (inst.t = {});
  const vx = e.vx || 0, vy = e.vy || 0, vz = e.vz || 0;
  const speed = Math.sqrt(vx * vx + vz * vz);

  let la = e.limbSwingAmount;
  if (la === undefined || la === null) la = Math.min(1, speed * 0.42);
  la = clamp(la, 0, 1.2);
  inst._la += (la - inst._la) * 0.4;

  let ls = e.limbSwing;
  if (ls === undefined || ls === null) {
    const last = inst._lastAge === null ? age : inst._lastAge;
    const dAge = clamp(age - last, 0, 3);
    inst._ls += dAge * (0.9 + inst._la * 1.6);
    ls = inst._ls;
  }
  inst._lastAge = age;

  const bodyYaw = e.bodyYaw !== undefined ? e.bodyYaw : (e.yaw || 0);
  const headYaw = e.headYaw !== undefined ? e.headYaw : (e.yaw || 0);
  t.entity = e;
  t.age = age;
  t.partial = pt;
  t.limbSwing = ls;
  t.limbSwingAmount = inst._la;
  t.headYaw = clamp(angleDiff(bodyYaw, headYaw), -1.5, 1.5);
  t.headPitch = clamp(e.headPitch !== undefined ? e.headPitch : (e.pitch || 0), -1.5, 1.5);
  t.speed = speed;
  t.vy = vy;
  t.onGround = e.onGround !== false;
  t.inWater = !!(e.inWater || e.submerged);
  t.sneak = !!e.sneaking;
  t.sprint = !!e.sprinting;
  t.attackTarget = e.target || null;
  t.hurt = clamp((e.hurtTime || 0) / 10, 0, 1);
  t.death = clamp((e.deathTime || 0) / 20, 0, 1);
  t.baby = e.baby === true || e.isBaby === true;
  t.riding = !!(e.riding || e.vehicle);
  let sw = e.swingProgress;
  if (sw === undefined || sw === null) sw = e.swinging ? clamp((e.swingTicks || 0) / 6, 0, 1) : 0;
  t.swing = clamp(sw, 0, 1);

  // --- the model's own animation ------------------------------------------
  if (def.animate) {
    try {
      def.animate(inst.parts, e, t);
    } catch (err) {
      if (!inst._err) { inst._err = true; console.error('[models] animate ' + def.name, err); }
    }
  }

  // --- shared post-processing ---------------------------------------------
  if (t.baby) {
    const b = def.baby || DEFAULT_BABY;
    inst.root.scale.multiplyScalar(b.bodyScale);
    const heads = b.head || DEFAULT_BABY.head;
    for (let i = 0; i < heads.length; i++) {
      const p = inst.parts[heads[i]];
      if (p) { p.scale.multiplyScalar(b.headScale); p.position.y += (b.headOffsetY || 0) * S; }
    }
  }
  if (t.hurt > 0 && t.death <= 0) {
    inst.root.rotation.z += sin(Math.sqrt(t.hurt) * PI * 3) * 0.22 * t.hurt;
    inst.root.rotation.x += sin(Math.sqrt(t.hurt) * PI * 3) * 0.06 * t.hurt;
  }
  if (t.death > 0) {
    const r = Math.min(1, Math.sqrt(t.death * 1.6));
    inst.root.rotation.z += r * HALF_PI;
    inst.root.position.y += r * 0.06;
  }
  // Damage flash. Materials are per-instance so this never leaks to other mobs.
  const tint = t.hurt > 0 ? 1 : 0;
  if (tint !== inst._tint) {
    inst._tint = tint;
    for (const m of inst.materials) {
      if (tint) m.color.setRGB(1.0, 0.45, 0.45);
      else m.color.setRGB(1, 1, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Animation helpers shared by many models
// ---------------------------------------------------------------------------

/** Classic four-limb walk cycle. */
function walk(p, t, amp = 1.4, armScale = 1) {
  const a = sin(t.limbSwing * 0.6662) * amp * t.limbSwingAmount;
  const b = sin(t.limbSwing * 0.6662 + PI) * amp * t.limbSwingAmount;
  if (p.right_leg) p.right_leg.rotation.x += a;
  if (p.left_leg) p.left_leg.rotation.x += b;
  if (p.right_arm) p.right_arm.rotation.x += b * armScale;
  if (p.left_arm) p.left_arm.rotation.x += a * armScale;
  return a;
}

/** Head look-at, used by nearly every model. */
function look(p, t, part = 'head') {
  const h = p[part];
  if (!h) return;
  h.rotation.y += t.headYaw;
  h.rotation.x += t.headPitch;
}

/** Slow idle sway so a standing mob is never perfectly frozen. */
function idle(p, t, amp = 0.05) {
  if (p.right_arm) { p.right_arm.rotation.z += cos(t.age * 0.09) * amp + amp; p.right_arm.rotation.x += sin(t.age * 0.067) * amp; }
  if (p.left_arm) { p.left_arm.rotation.z -= cos(t.age * 0.09) * amp + amp; p.left_arm.rotation.x -= sin(t.age * 0.067) * amp; }
}

/** Overhead arm swing when the entity attacks. */
function attackSwing(p, t, armName) {
  if (t.swing <= 0) return;
  const arm = p[armName] || p.right_arm;
  if (!arm) return;
  const f = sin(t.swing * PI);
  arm.rotation.x += f * 1.9;
  arm.rotation.z += sin(t.swing * PI * 2) * 0.32;
  if (p.body) p.body.rotation.y += sin(Math.sqrt(t.swing) * PI * 2) * 0.2;
}

// ===========================================================================
// Humanoid family - player, zombie, skeleton, piglin, villager, illagers ...
// ===========================================================================

/**
 * Builds the six standard biped parts. Options tweak proportions and the
 * optional outer (hat/jacket/sleeve/pant) layer.
 */
function humanoidParts(o) {
  o = o || {};
  const slim = !!o.slim;
  const aw = slim ? 3 : (o.armW || 4);
  const ad = o.armD || 4;
  const armLen = o.armLen || 12;
  const legLen = o.legLen || 12;
  const legW = o.legW || 4;
  const bodyH = o.bodyH || 12;
  const bodyW = o.bodyW || 8;
  const bodyD = o.bodyD || 4;
  const neck = legLen + bodyH;
  const shoulder = neck - 2;
  const outer = o.outer !== false;
  const hw = o.headW || 8, hh = o.headH || 8, hd = o.headD || 8;

  const headKids = [];
  if (outer) {
    headKids.push(P('hat', 0, 0, 0,
      [bxu(-hw / 2, -hh, -hd / 2, hw, hh, hd, 32, 0, 8, 8, 8, 0.5)], { alpha: true }));
  }
  if (o.headExtra) for (const k of o.headExtra) headKids.push(k);

  const head = P('head', 0, neck, 0,
    [bxu(-hw / 2, -hh, -hd / 2, hw, hh, hd, 0, 0, 8, 8, 8)], { children: headKids });

  const bodyKids = [];
  if (outer) bodyKids.push(P('jacket', 0, 0, 0,
    [bxu(-bodyW / 2, 0, -bodyD / 2, bodyW, bodyH, bodyD, 16, 32, 8, 12, 4, 0.25)], { alpha: true }));
  if (o.bodyExtra) for (const k of o.bodyExtra) bodyKids.push(k);
  const body = P('body', 0, neck, 0,
    [bxu(-bodyW / 2, 0, -bodyD / 2, bodyW, bodyH, bodyD, 16, 16, 8, 12, 4)], { children: bodyKids });

  const rArmKids = outer ? [P('right_sleeve', 0, 0, 0,
    [bxu(-(aw - 1), -2, -ad / 2, aw, armLen, ad, 40, 32, 4, 12, 4, 0.25)], { alpha: true })] : [];
  const lArmKids = outer ? [P('left_sleeve', 0, 0, 0,
    [bxu(-1, -2, -ad / 2, aw, armLen, ad, 48, 48, 4, 12, 4, 0.25)], { alpha: true })] : [];
  const right_arm = P('right_arm', -(bodyW / 2 + aw / 2), shoulder, 0,
    [bxu(-(aw - 1), -2, -ad / 2, aw, armLen, ad, 40, 16, 4, 12, 4)], { children: rArmKids });
  const left_arm = P('left_arm', bodyW / 2 + aw / 2, shoulder, 0,
    [bxu(-1, -2, -ad / 2, aw, armLen, ad, 32, 48, 4, 12, 4)], { children: lArmKids });

  const rLegKids = outer ? [P('right_pant', 0, 0, 0,
    [bxu(-legW / 2, 0, -2, legW, legLen, 4, 0, 32, 4, 12, 4, 0.25)], { alpha: true })] : [];
  const lLegKids = outer ? [P('left_pant', 0, 0, 0,
    [bxu(-legW / 2, 0, -2, legW, legLen, 4, 0, 48, 4, 12, 4, 0.25)], { alpha: true })] : [];
  const right_leg = P('right_leg', -legW / 2, legLen, 0,
    [bxu(-legW / 2, 0, -2, legW, legLen, 4, 0, 16, 4, 12, 4)], { children: rLegKids });
  const left_leg = P('left_leg', legW / 2, legLen, 0,
    [bxu(-legW / 2, 0, -2, legW, legLen, 4, 16, 48, 4, 12, 4)], { children: lLegKids });

  return [head, body, right_arm, left_arm, right_leg, left_leg];
}

/** The shared biped animation: walk, look, idle sway, sneak, swim, attack. */
function animHumanoid(p, e, t) {
  look(p, t);
  walk(p, t, 1.4, 0.72);
  idle(p, t);
  if (t.riding) {
    if (p.right_leg) { p.right_leg.rotation.x = -1.4; p.right_leg.rotation.y = -0.3; }
    if (p.left_leg) { p.left_leg.rotation.x = -1.4; p.left_leg.rotation.y = 0.3; }
    if (p.right_arm) p.right_arm.rotation.x += -0.6;
    if (p.left_arm) p.left_arm.rotation.x += -0.6;
  }
  if (t.sneak) {
    if (p.body) { p.body.rotation.x += 0.5; p.body.position.z += 0.25 * S; }
    if (p.head) p.head.position.y += 0.6 * S;
    if (p.right_arm) { p.right_arm.rotation.x += 0.4; p.right_arm.position.y -= 1.2 * S; }
    if (p.left_arm) { p.left_arm.rotation.x += 0.4; p.left_arm.position.y -= 1.2 * S; }
    if (p.right_leg) p.right_leg.position.z += 4 * S * 0.25;
    if (p.left_leg) p.left_leg.position.z += 4 * S * 0.25;
  }
  if (t.inWater && !t.onGround) {
    // Swimming: lean forward and paddle.
    if (p.right_arm) p.right_arm.rotation.x += sin(t.age * 0.3) * 0.8 - 0.8;
    if (p.left_arm) p.left_arm.rotation.x += sin(t.age * 0.3 + PI) * 0.8 - 0.8;
  }
  attackSwing(p, t, 'right_arm');
}

defineModel('humanoid', { skin: 'player', parts: humanoidParts({}), animate: animHumanoid });
defineModel('player', { skin: 'player', parts: humanoidParts({}), animate: animHumanoid });
defineModel('player_slim', { skin: 'alex', parts: humanoidParts({ slim: true }), animate: animHumanoid });

// --- zombie: stiff arms locked out in front ---------------------------------
function animZombie(p, e, t) {
  look(p, t);
  walk(p, t, 1.4, 0);
  const wave = sin(t.age * 0.067) * 0.05;
  const spread = Math.abs(sin(t.age * 0.09)) * 0.06;
  if (p.right_arm) {
    p.right_arm.rotation.x = -HALF_PI + sin(t.age * 0.067) * 0.12 - Math.abs(sin(t.limbSwing * 0.6662) * 0.6 * t.limbSwingAmount);
    p.right_arm.rotation.z = -0.05 - spread;
    p.right_arm.rotation.y = -0.1 + wave;
  }
  if (p.left_arm) {
    p.left_arm.rotation.x = -HALF_PI + sin(t.age * 0.067 + PI) * 0.12 - Math.abs(sin(t.limbSwing * 0.6662 + PI) * 0.6 * t.limbSwingAmount);
    p.left_arm.rotation.z = 0.05 + spread;
    p.left_arm.rotation.y = 0.1 - wave;
  }
  // Arms are held out, so a raised swing reads as a lunge instead.
  if (t.swing > 0) {
    const f = sin(t.swing * PI);
    if (p.right_arm) p.right_arm.rotation.x -= f * 0.9;
    if (p.left_arm) p.left_arm.rotation.x -= f * 0.9;
    if (p.body) p.body.rotation.x += f * 0.15;
  }
}
defineModel('zombie', { skin: 'zombie', parts: humanoidParts({}), animate: animZombie });
defineModel('drowned', { skin: 'drowned', parts: humanoidParts({}), animate: animZombie });
defineModel('husk', { skin: 'husk', parts: humanoidParts({}), animate: animZombie });
defineModel('piglin_zombie', { skin: 'zombified_piglin', parts: humanoidParts({}), animate: animZombie });

// --- skeleton: thin two-wide limbs, bow arms --------------------------------
const SKELETON_PARTS = humanoidParts({ armW: 2, armD: 2, legW: 2, outer: false });
function animSkeleton(p, e, t) {
  animHumanoid(p, e, t);
  if (e.aiming || e.usingItem) {
    if (p.right_arm) { p.right_arm.rotation.x = -HALF_PI + t.headPitch; p.right_arm.rotation.y = -0.35; }
    if (p.left_arm) { p.left_arm.rotation.x = -HALF_PI + t.headPitch + 0.1; p.left_arm.rotation.y = 0.62; }
    if (p.head) p.head.rotation.y = t.headYaw;
  }
}
defineModel('skeleton', { skin: 'skeleton', parts: SKELETON_PARTS, animate: animSkeleton });
defineModel('stray', { skin: 'stray', parts: humanoidParts({ armW: 2, armD: 2, legW: 2 }), animate: animSkeleton });
defineModel('bogged', { skin: 'bogged', parts: humanoidParts({ armW: 2, armD: 2, legW: 2 }), animate: animSkeleton });
defineModel('wither_skeleton', {
  skin: 'wither_skeleton', scale: 1.2,
  parts: humanoidParts({ armW: 2, armD: 2, legW: 2, outer: false }), animate: animSkeleton,
});

// --- piglin: flat snout and floppy ears -------------------------------------
const PIGLIN_HEAD_EXTRA = [
  P('nose', 0, -2, 0, [bxu(-2, 0, -6, 4, 3, 1, 31, 1, 4, 3, 1)]),
  P('right_ear', -5, -2, 0, [bxu(-2, -2, -1, 2, 5, 3, 51, 6, 2, 5, 3)], { rot: [0, 0, -0.5] }),
  P('left_ear', 5, -2, 0, [bxu(0, -2, -1, 2, 5, 3, 39, 6, 2, 5, 3)], { rot: [0, 0, 0.5] }),
];
function animPiglin(p, e, t) {
  animHumanoid(p, e, t);
  const flap = Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.5 + sin(t.age * 0.1) * 0.08;
  if (p.right_ear) p.right_ear.rotation.z = -0.5 - flap;
  if (p.left_ear) p.left_ear.rotation.z = 0.5 + flap;
}
defineModel('piglin', {
  skin: 'piglin', parts: humanoidParts({ headExtra: PIGLIN_HEAD_EXTRA }), animate: animPiglin,
});
defineModel('piglin_brute', {
  skin: 'piglin_brute', scale: 1.05,
  parts: humanoidParts({ headExtra: PIGLIN_HEAD_EXTRA }), animate: animPiglin,
});
defineModel('zombified_piglin', {
  skin: 'zombified_piglin', parts: humanoidParts({ headExtra: PIGLIN_HEAD_EXTRA }),
  animate: (p, e, t) => { animZombie(p, e, t); },
});

// --- villager family: big nose, crossed arms, robe ---------------------------
function villagerParts(o) {
  o = o || {};
  const headKids = [
    P('nose', 0, 2, 0, [bxu(-1, -1, -6, 2, 4, 2, 24, 0, 2, 4, 2)]),
    P('brow', 0, 0, 0, [bxu(-4, -6, -5, 8, 2, 1, 0, 0, 8, 2, 1)]),
  ];
  if (o.hat) headKids.push(o.hat);
  const parts = [
    P('head', 0, 24, 0, [bxu(-4, -10, -4, 8, 10, 8, 0, 0, 8, 8, 8)], { children: headKids }),
    P('body', 0, 24, 0, [
      bxu(-4, 0, -3, 8, 12, 6, 16, 16, 8, 12, 4),
    ], {
      children: [P('robe', 0, 0, 0, [bxu(-4, 0, -3, 8, 18, 6, 16, 32, 8, 12, 4, 0.5)], { alpha: true })],
    }),
    P('arms', 0, 22, 0, [
      bxu(-8, -2, -2, 16, 8, 4, 40, 16, 4, 12, 4),
      bxu(-4, 6, -2, 8, 4, 4, 40, 32, 4, 12, 4),
    ], { rot: [-0.75, 0, 0] }),
    P('right_leg', -2, 12, 0, [bxu(-2, 0, -2, 4, 12, 4, 0, 16, 4, 12, 4)]),
    P('left_leg', 2, 12, 0, [bxu(-2, 0, -2, 4, 12, 4, 16, 48, 4, 12, 4)]),
  ];
  return parts;
}
function animVillager(p, e, t) {
  look(p, t);
  const a = sin(t.limbSwing * 0.6662) * 1.3 * t.limbSwingAmount;
  if (p.right_leg) p.right_leg.rotation.x = a;
  if (p.left_leg) p.left_leg.rotation.x = -a;
  if (p.arms) {
    p.arms.rotation.x = -0.75 + sin(t.age * 0.067) * 0.05;
    p.arms.position.y += (Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount) * 0.5 * S;
    if (e.working || t.swing > 0) p.arms.rotation.x = -0.75 + sin(t.age * 0.5) * 0.45;
  }
  if (p.nose) p.nose.rotation.x = sin(t.age * 0.09) * 0.03;
}
defineModel('villager', { skin: 'villager', parts: villagerParts({}), animate: animVillager });
defineModel('wandering_trader', { skin: 'wandering_trader', parts: villagerParts({}), animate: animVillager });
defineModel('zombie_villager', {
  skin: 'zombie_villager',
  parts: villagerParts({}),
  animate: (p, e, t) => {
    animVillager(p, e, t);
    if (p.arms) p.arms.rotation.x = -HALF_PI - 0.35 + sin(t.age * 0.067) * 0.1;
  },
});
defineModel('witch', {
  skin: 'witch',
  parts: villagerParts({
    hat: P('hat', 0, 8, 0, [
      bxu(-5, -12, -5, 10, 2, 10, 0, 32, 8, 2, 8),
      bxu(-4, -15, -4, 8, 3, 8, 0, 42, 8, 3, 8),
      bxu(-3, -19, -3, 6, 4, 6, 0, 47, 6, 4, 6),
      bxu(-2, -22, -2, 3, 3, 3, 0, 54, 3, 3, 3),
    ], { rot: [0, 0, 0.06] }),
  }),
  animate: (p, e, t) => {
    animVillager(p, e, t);
    if (p.hat) { p.hat.rotation.z = 0.06 + sin(t.age * 0.09) * 0.04; p.hat.rotation.x = sin(t.age * 0.06) * 0.03; }
    if (p.nose) p.nose.rotation.x = -0.15;
  },
});

// --- illagers: villager head on a biped body ---------------------------------
function illagerParts(o) {
  o = o || {};
  const parts = humanoidParts({ outer: false });
  parts[0] = P('head', 0, 24, 0, [bxu(-4, -10, -4, 8, 10, 8, 0, 0, 8, 8, 8)], {
    children: [
      P('nose', 0, 2, 0, [bxu(-1, -1, -6, 2, 4, 2, 24, 0, 2, 4, 2)]),
      P('hat', 0, 0, 0, [bxu(-4, -10, -4, 8, 10, 8, 32, 0, 8, 8, 8, 0.45)], { alpha: true, visible: o.hat !== false }),
    ],
  });
  parts[1] = P('body', 0, 24, 0, [bxu(-4, 0, -3, 8, 12, 6, 16, 16, 8, 12, 4)], {
    children: [P('robe', 0, 0, 0, [bxu(-4, 0, -3, 8, 18, 6, 16, 32, 8, 12, 4, 0.5)], { alpha: true })],
  });
  parts.push(P('arms', 0, 22, 0, [
    bxu(-8, -2, -2, 16, 8, 4, 40, 16, 4, 12, 4),
    bxu(-4, 6, -2, 8, 4, 4, 40, 32, 4, 12, 4),
  ], { rot: [-0.75, 0, 0], visible: false }));
  return parts;
}
function animIllager(p, e, t) {
  look(p, t);
  walk(p, t, 1.4, 0.7);
  idle(p, t, 0.04);
  const crossed = e.crossedArms || e.state === 'crossed';
  if (p.arms) p.arms.visible = !!crossed;
  if (crossed) {
    if (p.right_arm) p.right_arm.visible = false;
    if (p.left_arm) p.left_arm.visible = false;
    if (p.arms) p.arms.rotation.x = -0.75 + sin(t.age * 0.067) * 0.05;
  }
  if (e.casting) {
    // Evoker / illusioner spellcasting: arms thrown out to the sides.
    const f = sin(t.age * 0.4);
    if (p.right_arm) { p.right_arm.rotation.x = -1.9 - f * 0.2; p.right_arm.rotation.z = -0.9; }
    if (p.left_arm) { p.left_arm.rotation.x = -1.9 - f * 0.2; p.left_arm.rotation.z = 0.9; }
  } else if (e.aiming || e.usingItem) {
    if (p.right_arm) { p.right_arm.rotation.x = -HALF_PI + t.headPitch; p.right_arm.rotation.y = -0.3; }
    if (p.left_arm) { p.left_arm.rotation.x = -HALF_PI + t.headPitch; p.left_arm.rotation.y = 0.55; }
  } else {
    attackSwing(p, t, 'right_arm');
  }
}
for (const il of ['pillager', 'vindicator', 'evoker', 'illusioner']) {
  defineModel(il, { skin: il, parts: illagerParts({ hat: il === 'evoker' || il === 'illusioner' }), animate: animIllager });
}
defineModel('illager', { skin: 'pillager', parts: illagerParts({}), animate: animIllager });

// ===========================================================================
// Quadruped family - cow, pig, sheep, goat, bears, hoglins, striders ...
// ===========================================================================

/**
 * Four-legged body plan. Every uv rectangle keeps the canonical painted size
 * (head 8x8x8 at 0,0 / body 10x16x8 at 28,8 / leg 4x12x4 at 0,16) so animal
 * skins line up no matter how the physical proportions are stretched.
 */
function quadrupedParts(o) {
  o = o || {};
  const hw = o.headW || 8, hh = o.headH || 8, hd = o.headD || 6;
  const headY = o.headY !== undefined ? o.headY : 20;
  const headZ = o.headZ !== undefined ? o.headZ : -8;
  const bw = o.bodyW || 12, bh = o.bodyH || 18, bd = o.bodyD || 10;
  const bodyY = o.bodyY !== undefined ? o.bodyY : 19;
  const bodyZ = o.bodyZ !== undefined ? o.bodyZ : 2;
  const lw = o.legW || 4, ll = o.legH || 12, ld = o.legD || lw;
  const legX = o.legX !== undefined ? o.legX : 3;
  const legFZ = o.legFrontZ !== undefined ? o.legFrontZ : -6;
  const legBZ = o.legBackZ !== undefined ? o.legBackZ : 7;
  const legY = o.legY !== undefined ? o.legY : ll;
  const hlw = o.hindLegW || lw, hll = o.hindLegH || ll, hld = o.hindLegD || ld;
  const hlY = o.hindLegY !== undefined ? o.hindLegY : legY;

  const head = P('head', 0, headY, headZ,
    [bxu(-hw / 2, -hh / 2, -hd, hw, hh, hd, 0, 0, 8, 8, 8)],
    { children: o.headExtra || [] });
  const body = P('body', 0, bodyY, bodyZ,
    [bxu(-bw / 2, -bh / 2, -bd / 2 - (o.bodyLift || 0), bw, bh, bd, 28, 8, 10, 16, 8)],
    { rot: [-HALF_PI, 0, 0], children: o.bodyExtra || [] });
  const leg = (name, x, y, z, w, h, d) =>
    P(name, x, y, z, [bxu(-w / 2, 0, -d / 2, w, h, d, 0, 16, 4, 12, 4)]);
  const parts = [
    head, body,
    leg('right_front_leg', -legX, legY, legFZ, lw, ll, ld),
    leg('left_front_leg', legX, legY, legFZ, lw, ll, ld),
    leg('right_hind_leg', -legX, hlY, legBZ, hlw, hll, hld),
    leg('left_hind_leg', legX, hlY, legBZ, hlw, hll, hld),
  ];
  if (o.extra) for (const p of o.extra) parts.push(p);
  return parts;
}

const QUAD_BABY = { bodyScale: 0.55, headScale: 1.9, headOffsetY: 0, head: ['head'] };

/** Diagonal-pair gait plus a little breathing bob and head tracking. */
function animQuadruped(p, e, t) {
  const a = cos(t.limbSwing * 0.6662) * 1.4 * t.limbSwingAmount;
  const b = cos(t.limbSwing * 0.6662 + PI) * 1.4 * t.limbSwingAmount;
  if (p.right_front_leg) p.right_front_leg.rotation.x = a;
  if (p.left_front_leg) p.left_front_leg.rotation.x = b;
  if (p.right_hind_leg) p.right_hind_leg.rotation.x = b;
  if (p.left_hind_leg) p.left_hind_leg.rotation.x = a;
  if (p.head) {
    p.head.rotation.y = t.headYaw;
    p.head.rotation.x = t.headPitch + sin(t.age * 0.05) * 0.02;
    if (e.eating) {
      // eat_grass goal: nose to the ground and tug.
      const g = clamp(e.eatTicks !== undefined ? e.eatTicks / 40 : 1, 0, 1);
      p.head.rotation.x = t.headPitch + g * 0.9 + sin(t.age * 0.6) * 0.12 * g;
      p.head.position.y -= g * 3 * S;
    }
  }
  if (p.body) p.body.position.y += sin(t.age * 0.08) * 0.15 * S + Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.4 * S;
  if (p.tail) {
    p.tail.rotation.x += sin(t.age * 0.12) * 0.12;
    p.tail.rotation.z += sin(t.age * 0.18) * 0.18 * (0.3 + t.limbSwingAmount);
  }
  if (p.right_ear) p.right_ear.rotation.z -= Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.25 + sin(t.age * 0.13) * 0.05;
  if (p.left_ear) p.left_ear.rotation.z += Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.25 + sin(t.age * 0.13) * 0.05;
}

const COW_EXTRA = [
  P('right_horn', -4, 4, -3, [bxu(-1, -4, -1, 1, 3, 1, 22, 0, 1, 3, 1)], { rot: [0, 0, -0.35] }),
  P('left_horn', 4, 4, -3, [bxu(0, -4, -1, 1, 3, 1, 22, 0, 1, 3, 1)], { rot: [0, 0, 0.35] }),
];
const TAIL = (y, z, len, u, v) => P('tail', 0, y, z, [bxu(-1, 0, -1, 2, len, 2, u, v, 2, len, 2)], { rot: [0.35, 0, 0] });

defineModel('cow', {
  skin: 'cow', baby: QUAD_BABY,
  parts: quadrupedParts({ headExtra: COW_EXTRA, extra: [TAIL(21, 9, 8, 0, 16)] }),
  animate: animQuadruped,
});
defineModel('mooshroom', {
  skin: 'mooshroom', baby: QUAD_BABY,
  parts: quadrupedParts({ headExtra: COW_EXTRA, extra: [TAIL(21, 9, 8, 0, 16)] }),
  animate: animQuadruped,
});
defineModel('pig', {
  skin: 'pig', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 12, headZ: -6, headD: 8, bodyY: 13, bodyZ: 2, bodyW: 10, bodyH: 16, bodyD: 8,
    legH: 6, legY: 6, legX: 3, legFrontZ: -5, legBackZ: 7,
    headExtra: [P('snout', 0, 0, -8, [bxu(-2, -1, -1, 4, 3, 1, 16, 16, 4, 3, 1)])],
    extra: [TAIL(14, 8, 5, 0, 16)],
  }),
  animate: animQuadruped,
});
defineModel('sheep', {
  skin: 'sheep', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 18, headZ: -7, headD: 6, bodyY: 17, bodyW: 12, bodyH: 16, bodyD: 8,
    legH: 12, legY: 12,
    headExtra: [P('wool_head', 0, 0, 0, [bxu(-3, -4, -6, 6, 6, 6, 0, 0, 8, 8, 8, 0.6)], { alpha: true })],
    bodyExtra: [P('wool_body', 0, 0, 0, [bxu(-6, -8, -5, 12, 16, 8, 28, 8, 10, 16, 8, 1.75)], { alpha: true })],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    const sheared = !!(e.sheared || e.shorn);
    if (p.wool_head) p.wool_head.visible = !sheared;
    if (p.wool_body) p.wool_body.visible = !sheared;
  },
});
defineModel('goat', {
  skin: 'goat', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 20, headZ: -8, headW: 6, headH: 7, headD: 7, bodyY: 19, bodyW: 9, bodyH: 16, bodyD: 12,
    legH: 12, legY: 12, legW: 3,
    headExtra: [
      P('right_horn', -3, 4, -4, [bxu(-1, -6, -1, 2, 6, 2, 22, 0, 2, 6, 2)], { rot: [-0.5, 0, -0.3] }),
      P('left_horn', 3, 4, -4, [bxu(-1, -6, -1, 2, 6, 2, 22, 0, 2, 6, 2)], { rot: [-0.5, 0, 0.3] }),
      P('right_ear', -4, 1, -2, [bxu(-3, -1, -1, 3, 2, 2, 0, 0, 3, 2, 2)], { rot: [0, 0, -0.3] }),
      P('left_ear', 4, 1, -2, [bxu(0, -1, -1, 3, 2, 2, 0, 0, 3, 2, 2)], { rot: [0, 0, 0.3] }),
    ],
    extra: [TAIL(21, 8, 4, 0, 16)],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (e.ramming) { if (p.head) p.head.rotation.x = 0.9; }
  },
});
defineModel('polar_bear', {
  skin: 'polar_bear', scale: 1.2, baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 20, headZ: -12, headW: 8, headH: 8, headD: 8, bodyY: 20, bodyW: 14, bodyH: 22, bodyD: 11,
    legH: 12, legY: 12, legW: 5, legX: 4, legFrontZ: -8, legBackZ: 9,
    headExtra: [
      P('snout', 0, -1, -8, [bxu(-2.5, -1, -3, 5, 4, 3, 0, 0, 5, 4, 3)]),
      P('right_ear', -4, 3, -3, [bxu(-2, -2, -1, 2, 2, 1, 0, 0, 2, 2, 1)]),
      P('left_ear', 4, 3, -3, [bxu(0, -2, -1, 2, 2, 1, 0, 0, 2, 2, 1)]),
    ],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (e.standing) {
      // Reared up on the hind legs before a swipe.
      const s = clamp(e.standTicks !== undefined ? e.standTicks / 20 : 1, 0, 1);
      if (p.body) p.body.rotation.x = -HALF_PI + s * 0.9;
      if (p.right_front_leg) p.right_front_leg.rotation.x = -1.6 + sin(t.age * 0.3) * 0.3;
      if (p.left_front_leg) p.left_front_leg.rotation.x = -1.6 + sin(t.age * 0.3 + 1) * 0.3;
      if (p.head) p.head.position.y += 6 * S;
    }
  },
});
defineModel('panda', {
  skin: 'panda', scale: 1.1, baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 15, headZ: -10, headW: 10, headH: 10, headD: 9, bodyY: 18, bodyW: 13, bodyH: 20, bodyD: 12,
    legH: 9, legY: 9, legW: 5, legX: 4, legFrontZ: -6, legBackZ: 8,
    headExtra: [
      P('right_ear', -5, 4, 0, [bxu(-2, -2, -1, 2, 3, 1, 0, 0, 2, 3, 1)]),
      P('left_ear', 5, 4, 0, [bxu(0, -2, -1, 2, 3, 1, 0, 0, 2, 3, 1)]),
    ],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (e.sitting || e.eating) {
      if (p.body) p.body.rotation.x = -HALF_PI + 0.6;
      if (p.right_front_leg) p.right_front_leg.rotation.x = -1.2 + sin(t.age * 0.25) * 0.2;
      if (p.left_front_leg) p.left_front_leg.rotation.x = -1.2 + sin(t.age * 0.25 + 0.6) * 0.2;
    }
    if (e.rolling) {
      if (p.body) p.body.rotation.x = -HALF_PI + t.age * 0.6;
    }
  },
});
defineModel('hoglin', {
  skin: 'hoglin', scale: 1.15, baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 16, headZ: -12, headW: 9, headH: 9, headD: 9, bodyY: 20, bodyW: 14, bodyH: 24, bodyD: 12,
    legH: 12, legY: 12, legW: 5, legX: 5, legFrontZ: -7, legBackZ: 10,
    headExtra: [
      P('right_horn', -5, 2, -6, [bxu(-2, -7, -1, 2, 7, 2, 22, 0, 2, 7, 2)], { rot: [0, 0, -0.6] }),
      P('left_horn', 5, 2, -6, [bxu(0, -7, -1, 2, 7, 2, 22, 0, 2, 7, 2)], { rot: [0, 0, 0.6] }),
      P('right_ear', -5, 3, 1, [bxu(-3, -1, -1, 3, 3, 1, 0, 0, 3, 3, 1)], { rot: [0, 0, -0.9] }),
      P('left_ear', 5, 3, 1, [bxu(0, -1, -1, 3, 3, 1, 0, 0, 3, 3, 1)], { rot: [0, 0, 0.9] }),
    ],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (t.swing > 0 && p.head) p.head.rotation.x += sin(t.swing * PI) * 0.8;
  },
});
defineModel('zoglin', { skin: 'zoglin', scale: 1.15, baby: QUAD_BABY, parts: MODELS.hoglin.parts, animate: MODELS.hoglin.animate });
defineModel('strider', {
  skin: 'strider', baby: QUAD_BABY,
  parts: [
    P('body', 0, 20, 0, [bxu(-8, -8, -8, 16, 16, 14, 28, 8, 10, 16, 8)], {
      children: [P('hair', 0, 0, 0, [bxu(-8, -9, -8, 16, 3, 14, 28, 8, 10, 16, 8, 0.35)], { alpha: true })],
    }),
    P('right_leg', -4, 12, 0, [bxu(-2, 0, -2, 4, 12, 4, 0, 16, 4, 12, 4)]),
    P('left_leg', 4, 12, 0, [bxu(-2, 0, -2, 4, 12, 4, 0, 16, 4, 12, 4)]),
  ],
  animate: (p, e, t) => {
    const a = sin(t.limbSwing * 0.5) * 1.1 * t.limbSwingAmount;
    if (p.right_leg) p.right_leg.rotation.x = a;
    if (p.left_leg) p.left_leg.rotation.x = -a;
    if (p.body) {
      p.body.rotation.z = sin(t.limbSwing * 0.5) * 0.12 * t.limbSwingAmount;
      p.body.position.y += Math.abs(sin(t.limbSwing * 0.5)) * t.limbSwingAmount * 1.5 * S;
      p.body.rotation.y = t.headYaw * 0.4;
    }
    if (p.hair) p.hair.rotation.x = sin(t.age * 0.1) * 0.05;
  },
});
defineModel('camel', {
  skin: 'camel', scale: 1.1, baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 34, headZ: -12, headW: 7, headH: 8, headD: 12, bodyY: 26, bodyW: 12, bodyH: 26, bodyD: 14,
    legH: 21, legY: 21, legW: 4, legX: 4, legFrontZ: -8, legBackZ: 10,
    headExtra: [
      P('right_ear', -3, 4, 2, [bxu(-2, -1, -1, 2, 3, 1, 0, 0, 2, 3, 1)]),
      P('left_ear', 3, 4, 2, [bxu(0, -1, -1, 2, 3, 1, 0, 0, 2, 3, 1)]),
    ],
    bodyExtra: [P('hump', 0, 0, 0, [bxu(-4, -14, -5, 8, 5, 10, 28, 8, 10, 16, 8)])],
    extra: [P('neck', 0, 26, -8, [bxu(-3, -14, -3, 6, 16, 6, 0, 16, 4, 12, 4)], { rot: [-0.2, 0, 0] })],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (p.neck) p.neck.rotation.x = -0.2 + sin(t.age * 0.05) * 0.05 + t.headPitch * 0.3;
    if (e.sitting || e.dashing === false) { /* pose handled by neck bob */ }
    if (e.sitting) {
      if (p.right_front_leg) p.right_front_leg.rotation.x = -1.5;
      if (p.left_front_leg) p.left_front_leg.rotation.x = -1.5;
      if (p.right_hind_leg) p.right_hind_leg.rotation.x = 1.5;
      if (p.left_hind_leg) p.left_hind_leg.rotation.x = 1.5;
    }
  },
});
defineModel('sniffer', {
  skin: 'sniffer', scale: 1.2, baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 20, headZ: -14, headW: 10, headH: 10, headD: 12, bodyY: 22, bodyW: 16, bodyH: 30, bodyD: 16,
    legH: 12, legY: 12, legW: 5, legX: 6, legFrontZ: -8, legBackZ: 12,
    headExtra: [
      P('right_ear', -5, 3, -4, [bxu(-2, -1, -2, 2, 9, 4, 0, 0, 2, 9, 4)], { rot: [0, 0, -0.25] }),
      P('left_ear', 5, 3, -4, [bxu(0, -1, -2, 2, 9, 4, 0, 0, 2, 9, 4)], { rot: [0, 0, 0.25] }),
      P('nose', 0, -2, -12, [bxu(-4, -2, -2, 8, 4, 3, 0, 0, 8, 4, 3)]),
    ],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (p.head) {
      const s = e.sniffing ? 1 : 0;
      p.head.rotation.x += s * 0.7 + sin(t.age * 0.35) * 0.08 * (0.3 + s);
      p.head.rotation.y += sin(t.age * 0.12) * 0.2 * (0.3 + s);
    }
  },
});
defineModel('armadillo', {
  skin: 'armadillo', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 8, headZ: -7, headW: 5, headH: 5, headD: 6, bodyY: 9, bodyW: 9, bodyH: 12, bodyD: 8,
    legH: 4, legY: 4, legW: 3, legX: 3, legFrontZ: -4, legBackZ: 4,
    headExtra: [
      P('right_ear', -2, 2, -1, [bxu(-2, -2, -1, 2, 3, 1, 0, 0, 2, 3, 1)]),
      P('left_ear', 2, 2, -1, [bxu(0, -2, -1, 2, 3, 1, 0, 0, 2, 3, 1)]),
    ],
    extra: [TAIL(9, 5, 6, 0, 16)],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (e.rolledUp || e.hiding) {
      // Curls into a ball: legs and head tuck under the shell.
      for (const k of ['right_front_leg', 'left_front_leg', 'right_hind_leg', 'left_hind_leg']) {
        if (p[k]) { p[k].rotation.x = 0; p[k].position.y -= 2 * S; p[k].visible = false; }
      }
      if (p.head) { p.head.position.z += 4 * S; p.head.position.y -= 2 * S; p.head.rotation.x = 1.2; }
      if (p.body) p.body.position.y -= 1.5 * S;
    }
  },
});
defineModel('ravager', {
  skin: 'ravager', scale: 1.05, baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 22, headZ: -14, headW: 16, headH: 14, headD: 12, bodyY: 26, bodyW: 20, bodyH: 34, bodyD: 20,
    legH: 21, legY: 21, legW: 8, legX: 8, legFrontZ: -8, legBackZ: 12,
    headExtra: [
      P('mouth', 0, -5, -10, [bxu(-8, 0, -4, 16, 3, 6, 0, 0, 16, 3, 6)]),
      P('right_horn', -10, 4, -8, [bxu(-2, -3, -2, 3, 10, 4, 0, 0, 3, 10, 4)], { rot: [0, 0, -0.4] }),
      P('left_horn', 10, 4, -8, [bxu(-1, -3, -2, 3, 10, 4, 0, 0, 3, 10, 4)], { rot: [0, 0, 0.4] }),
    ],
    extra: [P('neck', 0, 26, -8, [bxu(-5, -8, -8, 10, 10, 12, 0, 16, 4, 12, 4)])],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    const stun = e.stunTicks || 0;
    if (stun > 0) {
      if (p.head) { p.head.rotation.x = 0.7; p.head.rotation.z = sin(t.age * 0.9) * 0.25; }
    } else if (e.roaring) {
      if (p.head) p.head.rotation.x = -0.5 + sin(t.age * 0.8) * 0.1;
      if (p.mouth) p.mouth.rotation.x = -0.5;
    }
    if (p.mouth) p.mouth.rotation.x += Math.abs(sin(t.age * 0.15)) * 0.1;
  },
});

// ===========================================================================
// Pets, mounts and small animals
// ===========================================================================

defineModel('wolf', {
  skin: 'wolf', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 10.5, headZ: -7, headW: 6, headH: 6, headD: 4,
    bodyY: 10, bodyZ: 2, bodyW: 6, bodyH: 9, bodyD: 6,
    legH: 8, legY: 8, legW: 2, legX: 2.5, legFrontZ: -4, legBackZ: 7,
    headExtra: [
      P('snout', 0, -1, -4, [bxu(-1.5, -1, -3, 3, 3, 3, 0, 0, 3, 3, 3)]),
      P('right_ear', -2, 3, -5, [bxu(-1, -2, 0, 2, 2, 1, 0, 0, 2, 2, 1)]),
      P('left_ear', 2, 3, -5, [bxu(-1, -2, 0, 2, 2, 1, 0, 0, 2, 2, 1)]),
    ],
    extra: [
      P('mane', 0, 10, 2, [bxu(-4, -3, -3, 8, 6, 7, 28, 8, 10, 16, 8)], { rot: [-HALF_PI, 0, 0] }),
      P('tail', 0, 12, 8, [bxu(-1, 0, -1, 2, 8, 2, 0, 16, 4, 12, 4)], { rot: [0.4, 0, 0] }),
    ],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (p.tail) {
      const wag = e.tamed || e.happy ? 0.9 : 0.25;
      p.tail.rotation.z += sin(t.age * 0.45) * wag;
    }
    if (e.angry) {
      if (p.head) p.head.rotation.x += 0.2;
      if (p.mane) p.mane.position.y += 0.6 * S;
    }
    if (e.shaking) {
      const s = sin(t.age * 1.4);
      if (p.body) p.body.rotation.z = s * 0.4;
      if (p.head) p.head.rotation.z = s * 0.5;
    }
    if (e.sitting) {
      if (p.body) { p.body.rotation.x = -HALF_PI + 0.35; p.body.position.y -= 1.5 * S; }
      if (p.mane) { p.mane.rotation.x = -HALF_PI + 0.35; p.mane.position.y -= 1.5 * S; }
      if (p.right_hind_leg) { p.right_hind_leg.rotation.x = HALF_PI; p.right_hind_leg.position.y -= 3.5 * S; p.right_hind_leg.position.z -= 1 * S; }
      if (p.left_hind_leg) { p.left_hind_leg.rotation.x = HALF_PI; p.left_hind_leg.position.y -= 3.5 * S; p.left_hind_leg.position.z -= 1 * S; }
      if (p.right_front_leg) p.right_front_leg.rotation.x = 0;
      if (p.left_front_leg) p.left_front_leg.rotation.x = 0;
    }
  },
});

function felineParts(o) {
  o = o || {};
  return quadrupedParts({
    headY: 9, headZ: -6, headW: 5, headH: 4, headD: 5,
    bodyY: 9, bodyZ: 1, bodyW: 4, bodyH: 13, bodyD: 5,
    legH: 5, legY: 5, legW: 2, legX: 1.6, legFrontZ: -4, legBackZ: 6,
    headExtra: [
      P('right_ear', -1.6, 2, -1, [bxu(-1, -2, -1, 2, 2, 1, 0, 0, 2, 2, 1)]),
      P('left_ear', 1.6, 2, -1, [bxu(-1, -2, -1, 2, 2, 1, 0, 0, 2, 2, 1)]),
      P('snout', 0, -1, -3, [bxu(-1, -1, -2, 2, 2, 2, 0, 0, 2, 2, 2)]),
    ],
    extra: [
      P('tail', 0, 10, 7, [bxu(-0.5, 0, -0.5, 1, 8, 1, 0, 16, 4, 12, 4)], { rot: [0.9, 0, 0] }),
      P('tail_tip', 0, -8, 0, [bxu(-0.5, 0, -0.5, 1, 6, 1, 0, 16, 4, 12, 4)], { rot: [0.4, 0, 0] }),
    ],
  });
}
function animFeline(p, e, t) {
  animQuadruped(p, e, t);
  if (p.tail) p.tail.rotation.z += sin(t.age * 0.14) * 0.35;
  if (p.tail_tip) p.tail_tip.rotation.z += sin(t.age * 0.14 - 0.6) * 0.35;
  if (e.sitting) {
    if (p.body) { p.body.rotation.x = -HALF_PI + 0.55; p.body.position.y -= 1 * S; }
    if (p.right_hind_leg) { p.right_hind_leg.rotation.x = HALF_PI; p.right_hind_leg.position.y -= 2 * S; }
    if (p.left_hind_leg) { p.left_hind_leg.rotation.x = HALF_PI; p.left_hind_leg.position.y -= 2 * S; }
    if (p.right_front_leg) p.right_front_leg.rotation.x = 0;
    if (p.left_front_leg) p.left_front_leg.rotation.x = 0;
  } else if (e.sneaking || e.crouching) {
    if (p.body) p.body.position.y -= 1.5 * S;
    if (p.head) p.head.position.y -= 1.5 * S;
  }
}
defineModel('cat', { skin: 'cat', baby: QUAD_BABY, parts: felineParts({}), animate: animFeline });
defineModel('ocelot', { skin: 'ocelot', baby: QUAD_BABY, parts: felineParts({}), animate: animFeline });

defineModel('fox', {
  skin: 'fox', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 10, headZ: -8, headW: 8, headH: 6, headD: 6,
    bodyY: 10, bodyZ: 2, bodyW: 6, bodyH: 11, bodyD: 6,
    legH: 6, legY: 6, legW: 2, legX: 2, legFrontZ: -4, legBackZ: 6,
    headExtra: [
      P('snout', 0, -1, -6, [bxu(-2, -1, -3, 4, 3, 3, 0, 0, 4, 3, 3)]),
      P('right_ear', -3, 3, -3, [bxu(-2, -4, -1, 2, 4, 1, 0, 0, 2, 4, 1)]),
      P('left_ear', 3, 3, -3, [bxu(0, -4, -1, 2, 4, 1, 0, 0, 2, 4, 1)]),
    ],
    extra: [P('tail', 0, 11, 7, [bxu(-2.5, 0, -2.5, 5, 11, 5, 0, 16, 4, 12, 4)], { rot: [0.6, 0, 0] })],
  }),
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (p.tail) p.tail.rotation.z += sin(t.age * 0.11) * 0.25;
    if (e.pouncing) {
      if (p.body) p.body.rotation.x = -HALF_PI - 0.6;
      if (p.right_front_leg) p.right_front_leg.rotation.x = -1.4;
      if (p.left_front_leg) p.left_front_leg.rotation.x = -1.4;
    } else if (e.sleeping) {
      if (p.head) { p.head.rotation.z = 1.4; p.head.position.y -= 4 * S; }
      if (p.body) p.body.position.y -= 3 * S;
      for (const k of ['right_front_leg', 'left_front_leg', 'right_hind_leg', 'left_hind_leg']) {
        if (p[k]) { p[k].rotation.z = HALF_PI; p[k].position.y -= 3 * S; }
      }
    }
  },
});

defineModel('rabbit', {
  skin: 'rabbit', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 8, headZ: -4, headW: 5, headH: 4, headD: 5,
    bodyY: 6, bodyZ: 1, bodyW: 6, bodyH: 10, bodyD: 5,
    legH: 4, legY: 4, legW: 2, legX: 2, legFrontZ: -2.5,
    hindLegW: 2, hindLegH: 2, hindLegD: 6, hindLegY: 2, legBackZ: 4,
    headExtra: [
      P('right_ear', -1.5, 3, 0, [bxu(-1, -6, -0.5, 2, 6, 1, 0, 0, 2, 6, 1)], { rot: [-0.15, 0, -0.15] }),
      P('left_ear', 1.5, 3, 0, [bxu(-1, -6, -0.5, 2, 6, 1, 0, 0, 2, 6, 1)], { rot: [-0.15, 0, 0.15] }),
      P('nose', 0, -1, -3, [bxu(-1, -1, -1, 2, 2, 1, 0, 0, 2, 2, 1)]),
    ],
    extra: [P('tail', 0, 6, 5, [bxu(-1.5, 0, -1, 3, 3, 2, 0, 16, 4, 12, 4)])],
  }),
  animate: (p, e, t) => {
    // Rabbits hop rather than walk: everything is driven by one jump phase.
    const hop = Math.abs(sin(t.limbSwing * 0.5)) * t.limbSwingAmount;
    if (p.right_hind_leg) p.right_hind_leg.rotation.x = -hop * 1.2;
    if (p.left_hind_leg) p.left_hind_leg.rotation.x = -hop * 1.2;
    if (p.right_front_leg) p.right_front_leg.rotation.x = -hop * 1.6;
    if (p.left_front_leg) p.left_front_leg.rotation.x = -hop * 1.6;
    if (p.body) { p.body.rotation.x = -HALF_PI - hop * 0.5; p.body.position.y += hop * 2 * S; }
    if (p.head) { p.head.rotation.y = t.headYaw; p.head.rotation.x = t.headPitch - hop * 0.3; p.head.position.y += hop * 2 * S; }
    const twitch = sin(t.age * 0.07) * 0.15 + Math.abs(sin(t.age * 0.31)) * 0.1;
    if (p.right_ear) p.right_ear.rotation.z -= twitch;
    if (p.left_ear) p.left_ear.rotation.z += twitch;
  },
});

// --- horse family ----------------------------------------------------------
function horseParts(o) {
  o = o || {};
  const ear = o.longEars ? 7 : 3;
  return [
    P('body', 0, 18, 0, [bxu(-5, -11, -11, 10, 22, 10, 28, 8, 10, 16, 8)], {
      rot: [-HALF_PI, 0, 0],
      children: o.chest ? [
        P('right_chest', -8.5, 0, 3, [bxu(-3, -3, -4, 3, 8, 8, 28, 8, 10, 16, 8)]),
        P('left_chest', 8.5, 0, 3, [bxu(0, -3, -4, 3, 8, 8, 28, 8, 10, 16, 8)]),
      ] : [],
    }),
    P('neck', 0, 22, -9, [bxu(-2, -16, -2, 4, 16, 9, 0, 16, 4, 12, 4)], {
      rot: [-0.6, 0, 0],
      children: [
        P('head', 0, 16, -1, [bxu(-2.5, -6, -11, 5, 7, 11, 0, 0, 8, 8, 8)], {
          children: [
            P('mane', 0, 0, 2, [bxu(-1, -6, 0, 2, 16, 4, 0, 16, 4, 12, 4)]),
            P('right_ear', -2, 6, -8, [bxu(-1, -ear, -1, 2, ear, 2, 0, 0, 2, 3, 2)], { rot: [0, 0, -0.2] }),
            P('left_ear', 2, 6, -8, [bxu(-1, -ear, -1, 2, ear, 2, 0, 0, 2, 3, 2)], { rot: [0, 0, 0.2] }),
            P('muzzle', 0, -2, -11, [bxu(-2, 0, -2, 4, 5, 3, 0, 0, 4, 5, 3)]),
          ],
        }),
      ],
    }),
    P('tail', 0, 21, 10, [bxu(-1.5, 0, -1, 3, 14, 4, 0, 16, 4, 12, 4)], { rot: [0.9, 0, 0] }),
    P('right_front_leg', -4, 14, -7, [bxu(-2, 0, -2, 4, 9, 4, 0, 16, 4, 12, 4)], {
      children: [P('right_front_shin', 0, -9, 0, [bxu(-1.5, 0, -1.5, 3, 5, 3, 0, 16, 4, 12, 4)])],
    }),
    P('left_front_leg', 4, 14, -7, [bxu(-2, 0, -2, 4, 9, 4, 0, 16, 4, 12, 4)], {
      children: [P('left_front_shin', 0, -9, 0, [bxu(-1.5, 0, -1.5, 3, 5, 3, 0, 16, 4, 12, 4)])],
    }),
    P('right_hind_leg', -4, 15, 8, [bxu(-2.5, 0, -2.5, 5, 8, 5, 0, 16, 4, 12, 4)], {
      children: [P('right_hind_shin', 0, -8, 0, [bxu(-1.5, 0, -1.5, 3, 7, 3, 0, 16, 4, 12, 4)])],
    }),
    P('left_hind_leg', 4, 15, 8, [bxu(-2.5, 0, -2.5, 5, 8, 5, 0, 16, 4, 12, 4)], {
      children: [P('left_hind_shin', 0, -8, 0, [bxu(-1.5, 0, -1.5, 3, 7, 3, 0, 16, 4, 12, 4)])],
    }),
  ];
}
function animHorse(p, e, t) {
  const a = cos(t.limbSwing * 0.6662) * 1.2 * t.limbSwingAmount;
  const b = cos(t.limbSwing * 0.6662 + PI) * 1.2 * t.limbSwingAmount;
  if (p.right_front_leg) p.right_front_leg.rotation.x = a;
  if (p.left_front_leg) p.left_front_leg.rotation.x = b;
  if (p.right_hind_leg) p.right_hind_leg.rotation.x = b;
  if (p.left_hind_leg) p.left_hind_leg.rotation.x = a;
  if (p.right_front_shin) p.right_front_shin.rotation.x = Math.max(0, -a) * 0.8;
  if (p.left_front_shin) p.left_front_shin.rotation.x = Math.max(0, -b) * 0.8;
  if (p.right_hind_shin) p.right_hind_shin.rotation.x = Math.max(0, -b) * 0.8;
  if (p.left_hind_shin) p.left_hind_shin.rotation.x = Math.max(0, -a) * 0.8;
  if (p.neck) p.neck.rotation.x = -0.6 + t.headPitch * 0.4 + sin(t.age * 0.05) * 0.03;
  if (p.neck) p.neck.rotation.y = t.headYaw * 0.5;
  if (p.head) { p.head.rotation.x = t.headPitch * 0.6 + 0.3; p.head.rotation.y = t.headYaw * 0.5; }
  if (p.tail) {
    p.tail.rotation.x = 0.9 + t.limbSwingAmount * 0.35;
    p.tail.rotation.z = sin(t.age * 0.2) * 0.15;
  }
  const flick = sin(t.age * 0.17) * 0.12;
  if (p.right_ear) p.right_ear.rotation.z = -0.2 - flick;
  if (p.left_ear) p.left_ear.rotation.z = 0.2 + flick;
  if (e.rearing) {
    const r = clamp(e.rearTicks !== undefined ? e.rearTicks / 20 : 1, 0, 1);
    if (p.body) p.body.rotation.x = -HALF_PI - r * 0.8;
    if (p.right_front_leg) p.right_front_leg.rotation.x = -1.5 - r * 0.4;
    if (p.left_front_leg) p.left_front_leg.rotation.x = -1.5 - r * 0.4;
    if (p.neck) p.neck.rotation.x = -1.1;
  }
  if (p.body) p.body.position.y += Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.6 * S;
}
defineModel('horse', { skin: 'horse', baby: QUAD_BABY, parts: horseParts({}), animate: animHorse });
defineModel('donkey', { skin: 'donkey', scale: 0.87, baby: QUAD_BABY, parts: horseParts({ longEars: true, chest: true }), animate: animHorse });
defineModel('mule', { skin: 'mule', scale: 0.92, baby: QUAD_BABY, parts: horseParts({ longEars: true, chest: true }), animate: animHorse });
defineModel('skeleton_horse', { skin: 'skeleton_horse', baby: QUAD_BABY, parts: horseParts({}), animate: animHorse });
defineModel('zombie_horse', { skin: 'zombie_horse', baby: QUAD_BABY, parts: horseParts({}), animate: animHorse });

defineModel('llama', {
  skin: 'llama', baby: QUAD_BABY,
  parts: [
    P('body', 0, 20, 0, [bxu(-6, -14, -8, 12, 18, 10, 28, 8, 10, 16, 8)], {
      rot: [-HALF_PI, 0, 0],
      children: [
        P('right_chest', -8.5, -2, 3, [bxu(-3, -3, -4, 3, 8, 8, 28, 8, 10, 16, 8)], { visible: false }),
        P('left_chest', 8.5, -2, 3, [bxu(0, -3, -4, 3, 8, 8, 28, 8, 10, 16, 8)], { visible: false }),
      ],
    }),
    P('neck', 0, 22, -6, [bxu(-2, -16, -4, 4, 16, 9, 0, 16, 4, 12, 4)], {
      rot: [-0.25, 0, 0],
      children: [
        P('head', 0, 16, -2, [bxu(-2, -6, -8, 4, 8, 9, 0, 0, 8, 8, 8)], {
          children: [
            P('right_ear', -2, 6, -3, [bxu(-1, -5, -1, 2, 5, 1, 0, 0, 2, 5, 1)], { rot: [0, 0, -0.25] }),
            P('left_ear', 2, 6, -3, [bxu(-1, -5, -1, 2, 5, 1, 0, 0, 2, 5, 1)], { rot: [0, 0, 0.25] }),
          ],
        }),
      ],
    }),
    P('right_front_leg', -3.5, 14, -5, [bxu(-2, 0, -2, 4, 14, 4, 0, 16, 4, 12, 4)]),
    P('left_front_leg', 3.5, 14, -5, [bxu(-2, 0, -2, 4, 14, 4, 0, 16, 4, 12, 4)]),
    P('right_hind_leg', -3.5, 14, 6, [bxu(-2, 0, -2, 4, 14, 4, 0, 16, 4, 12, 4)]),
    P('left_hind_leg', 3.5, 14, 6, [bxu(-2, 0, -2, 4, 14, 4, 0, 16, 4, 12, 4)]),
  ],
  animate: (p, e, t) => {
    animQuadruped(p, e, t);
    if (p.neck) { p.neck.rotation.x = -0.25 + t.headPitch * 0.3 + sin(t.age * 0.06) * 0.04; p.neck.rotation.y = t.headYaw * 0.6; }
    if (p.head) p.head.rotation.set(0, 0, 0);
    const chest = !!(e.chested || e.hasChest);
    if (p.right_chest) p.right_chest.visible = chest;
    if (p.left_chest) p.left_chest.visible = chest;
    const ear = sin(t.age * 0.15) * 0.1;
    if (p.right_ear) p.right_ear.rotation.z = -0.25 - ear;
    if (p.left_ear) p.left_ear.rotation.z = 0.25 + ear;
  },
});
defineModel('trader_llama', { skin: 'trader_llama', baby: QUAD_BABY, parts: MODELS.llama.parts, animate: MODELS.llama.animate });

defineModel('turtle', {
  skin: 'turtle', baby: QUAD_BABY,
  parts: quadrupedParts({
    headY: 6, headZ: -10, headW: 6, headH: 5, headD: 6,
    bodyY: 7, bodyZ: 0, bodyW: 18, bodyH: 20, bodyD: 6,
    legH: 3, legY: 3, legW: 4, legX: 8, legFrontZ: -6, legBackZ: 6,
    hindLegW: 5, hindLegH: 3, hindLegD: 8,
    bodyExtra: [P('shell', 0, 0, 0, [bxu(-8, -9, -5, 16, 18, 4, 28, 8, 10, 16, 8)])],
  }),
  animate: (p, e, t) => {
    if (p.head) { p.head.rotation.y = t.headYaw; p.head.rotation.x = t.headPitch; }
    const swim = t.inWater;
    const a = cos(t.limbSwing * 0.6662) * (swim ? 1.4 : 0.8) * t.limbSwingAmount;
    // In water the flippers row together; on land they paddle diagonally.
    if (p.right_front_leg) p.right_front_leg.rotation.y = swim ? a : 0;
    if (p.left_front_leg) p.left_front_leg.rotation.y = swim ? -a : 0;
    if (p.right_front_leg) p.right_front_leg.rotation.x = swim ? -0.6 : a;
    if (p.left_front_leg) p.left_front_leg.rotation.x = swim ? -0.6 : (swim ? a : -a);
    if (p.right_hind_leg) p.right_hind_leg.rotation.x = swim ? sin(t.limbSwing * 0.6662) * 0.5 : -a;
    if (p.left_hind_leg) p.left_hind_leg.rotation.x = swim ? sin(t.limbSwing * 0.6662 + PI) * 0.5 : a;
    if (p.body) p.body.rotation.z = swim ? sin(t.age * 0.1) * 0.06 : 0;
    if (e.digging) { if (p.body) p.body.position.y -= 1 * S; }
  },
});

defineModel('frog', {
  skin: 'frog',
  parts: [
    P('body', 0, 4, 0, [bxu(-4, -4, -8, 8, 4, 8, 0, 0, 8, 4, 8)], {
      children: [
        P('head', 0, 0, -7, [bxu(-4, -3, -3, 8, 3, 4, 0, 0, 8, 4, 8)], {
          children: [
            P('right_eye', -2.5, 3, -1, [bxu(-1.5, -2, -1.5, 3, 2, 3, 0, 0, 3, 2, 3)]),
            P('left_eye', 2.5, 3, -1, [bxu(-1.5, -2, -1.5, 3, 2, 3, 0, 0, 3, 2, 3)]),
          ],
        }),
        P('croaking_body', 0, -1, -6, [bxu(-3.5, 0, -2, 7, 3, 4, 0, 0, 7, 3, 4)], { visible: false }),
      ],
    }),
    P('right_arm', -4, 3, -5, [bxu(-1.5, 0, -1.5, 3, 3, 3, 0, 0, 3, 3, 3)]),
    P('left_arm', 4, 3, -5, [bxu(-1.5, 0, -1.5, 3, 3, 3, 0, 0, 3, 3, 3)]),
    P('right_leg', -4, 4, 3, [bxu(-2, 0, -2, 4, 4, 5, 0, 0, 4, 4, 5)], { rot: [0, -0.35, 0] }),
    P('left_leg', 4, 4, 3, [bxu(-2, 0, -2, 4, 4, 5, 0, 0, 4, 4, 5)], { rot: [0, 0.35, 0] }),
  ],
  animate: (p, e, t) => {
    look(p, t);
    const hop = Math.abs(sin(t.limbSwing * 0.5)) * t.limbSwingAmount;
    if (p.right_leg) p.right_leg.rotation.x = -hop * 1.3;
    if (p.left_leg) p.left_leg.rotation.x = -hop * 1.3;
    if (p.right_arm) p.right_arm.rotation.x = -hop * 0.9;
    if (p.left_arm) p.left_arm.rotation.x = -hop * 0.9;
    if (p.body) p.body.position.y += hop * 2.5 * S;
    if (p.croaking_body) {
      const croak = e.croaking ? (0.5 + 0.5 * sin(t.age * 0.5)) : 0;
      p.croaking_body.visible = croak > 0.05;
      p.croaking_body.scale.setScalar(0.6 + croak * 0.6);
    }
    const blink = Math.abs(sin(t.age * 0.03)) > 0.995 ? 0.4 : 1;
    if (p.right_eye) p.right_eye.scale.y = blink;
    if (p.left_eye) p.left_eye.scale.y = blink;
  },
});
defineModel('tadpole', {
  skin: 'tadpole',
  parts: [
    P('body', 0, 2, 0, [bxu(-1.5, -1.5, -3, 3, 3, 4, 0, 0, 4, 4, 4)]),
    P('tail', 0, 2, 1, [bxu(0, -1.5, 0, 0, 3, 7, 0, 0, 4, 4, 4)]),
  ],
  animate: (p, e, t) => {
    const s = sin(t.age * 0.6) * (0.3 + t.limbSwingAmount * 0.7);
    if (p.tail) p.tail.rotation.y = s;
    if (p.body) p.body.rotation.y = s * 0.2;
  },
});

defineModel('axolotl', {
  skin: 'axolotl', baby: QUAD_BABY,
  parts: [
    P('body', 0, 5, 0, [bxu(-4, -5, -8, 8, 5, 10, 0, 0, 8, 5, 6)], {
      children: [
        P('tail', 0, -2, 2, [bxu(0, -3, 0, 0, 5, 12, 0, 0, 0, 5, 12)]),
      ],
    }),
    P('head', 0, 6, -7, [bxu(-4, -4, -5, 8, 5, 5, 0, 0, 8, 5, 6)], {
      children: [
        P('right_gill', -4, 1, -1, [bxu(-3, -2, -2, 3, 4, 4, 0, 0, 3, 4, 4)]),
        P('left_gill', 4, 1, -1, [bxu(0, -2, -2, 3, 4, 4, 0, 0, 3, 4, 4)]),
        P('top_gill', 0, 4, -1, [bxu(-2, -3, -2, 4, 3, 4, 0, 0, 4, 3, 4)]),
      ],
    }),
    P('right_leg', -3.5, 2, -4, [bxu(-1, 0, -1, 2, 3, 2, 0, 0, 2, 3, 2)]),
    P('left_leg', 3.5, 2, -4, [bxu(-1, 0, -1, 2, 3, 2, 0, 0, 2, 3, 2)]),
    P('right_hind_leg', -3.5, 2, 4, [bxu(-1, 0, -1, 2, 3, 2, 0, 0, 2, 3, 2)]),
    P('left_hind_leg', 3.5, 2, 4, [bxu(-1, 0, -1, 2, 3, 2, 0, 0, 2, 3, 2)]),
  ],
  animate: (p, e, t) => {
    look(p, t);
    const swim = t.inWater ? 1 : 0.25;
    const s = sin(t.age * 0.25) * swim;
    if (p.tail) p.tail.rotation.y = s * 0.7;
    if (p.body) p.body.rotation.z = s * 0.08;
    const g = sin(t.age * 0.3) * 0.25 * swim;
    if (p.right_gill) p.right_gill.rotation.y = -g;
    if (p.left_gill) p.left_gill.rotation.y = g;
    if (p.top_gill) p.top_gill.rotation.x = g * 0.5;
    const paddle = sin(t.age * 0.25) * 0.4 * swim;
    if (p.right_leg) p.right_leg.rotation.x = paddle;
    if (p.left_leg) p.left_leg.rotation.x = -paddle;
    if (p.right_hind_leg) p.right_hind_leg.rotation.x = -paddle;
    if (p.left_hind_leg) p.left_hind_leg.rotation.x = paddle;
    if (e.playingDead) {
      if (p.body) p.body.rotation.z = PI;
      if (p.head) p.head.rotation.z = PI;
    }
  },
});

// ===========================================================================
// Birds and insects
// ===========================================================================

defineModel('chicken', {
  skin: 'chicken', baby: { bodyScale: 0.5, headScale: 1.6, headOffsetY: 0, head: ['head'] },
  parts: [
    P('head', 0, 9, -4, [bx(-2, -6, -2, 4, 6, 3, 0, 0)], {
      children: [
        P('bill', 0, 0, 0, [bx(-2, -4, -4, 4, 2, 2, 14, 0)]),
        P('wattle', 0, 0, 0, [bx(-1, -2, -3, 2, 2, 2, 14, 4)]),
      ],
    }),
    P('body', 0, 8, 0, [bx(-3, -4, -3, 6, 8, 6, 0, 9)], { rot: [-HALF_PI, 0, 0] }),
    P('right_leg', -2, 5, 1, [bx(-1, 0, -3, 3, 5, 3, 26, 0)]),
    P('left_leg', 2, 5, 1, [bx(-1, 0, -3, 3, 5, 3, 26, 0)]),
    P('right_wing', -4, 11, 0, [bx(0, 0, -3, 1, 5, 6, 24, 13)]),
    P('left_wing', 4, 11, 0, [bx(-1, 0, -3, 1, 5, 6, 24, 13)]),
  ],
  animate: (p, e, t) => {
    look(p, t);
    const a = sin(t.limbSwing * 0.6662) * 1.4 * t.limbSwingAmount;
    if (p.right_leg) p.right_leg.rotation.x = a;
    if (p.left_leg) p.left_leg.rotation.x = -a;
    // Wings only beat while falling; a walking chicken just bobs its wattle.
    const falling = t.vy < -0.1 && !t.onGround;
    const flap = falling ? (sin(t.age * 1.5) * 0.9 + 0.9) : Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.3;
    if (p.right_wing) p.right_wing.rotation.z = -flap;
    if (p.left_wing) p.left_wing.rotation.z = flap;
    const bob = sin(t.limbSwing * 0.6662) * 0.35 * t.limbSwingAmount;
    if (p.head) { p.head.rotation.x += bob * 0.4; p.head.position.z += bob * 0.6 * S; }
    if (p.wattle) p.wattle.rotation.x = sin(t.limbSwing * 0.6662 - 0.6) * 0.5 * t.limbSwingAmount + sin(t.age * 0.2) * 0.05;
    if (p.body) p.body.position.y += Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.5 * S;
  },
});

defineModel('parrot', {
  skin: 'parrot',
  parts: [
    P('body', 0, 7.5, -3, [bx(-1.5, 0, -1.5, 3, 6, 3, 2, 8)], { rot: [0.5, 0, 0] }),
    P('head', 0, 8.5, -3, [bx(-1, -1.5, -1, 2, 3, 2, 2, 2)], {
      children: [
        P('crest', 0, 0, 0, [bx(-1, -3.5, -0.5, 2, 3, 1, 10, 0)]),
        P('beak', 0, 0, 0, [bx(-0.5, -1, -2.5, 1, 2, 1, 11, 7)]),
      ],
    }),
    P('tail', 0, 3, 1.5, [bx(-1.5, -1, -1, 3, 4, 1, 22, 1)], { rot: [1.0, 0, 0] }),
    P('right_wing', -1.5, 8, -1.5, [bx(-0.5, 0, -1.5, 1, 5, 3, 19, 8)]),
    P('left_wing', 1.5, 8, -1.5, [bx(-0.5, 0, -1.5, 1, 5, 3, 19, 8)]),
    P('right_leg', -1.5, 2, -2.5, [bx(-0.5, 0, -0.5, 1, 2, 1, 14, 18)]),
    P('left_leg', 1.5, 2, -2.5, [bx(-0.5, 0, -0.5, 1, 2, 1, 14, 18)]),
  ],
  animate: (p, e, t) => {
    look(p, t);
    const flying = !t.onGround;
    const flap = flying ? sin(t.age * 1.9) : 0;
    if (p.right_wing) { p.right_wing.rotation.z = -0.15 - flap * 1.1; p.right_wing.rotation.x = flying ? 0.4 : 0; }
    if (p.left_wing) { p.left_wing.rotation.z = 0.15 + flap * 1.1; p.left_wing.rotation.x = flying ? 0.4 : 0; }
    const step = sin(t.limbSwing * 0.6662) * 1.0 * t.limbSwingAmount;
    if (p.right_leg) p.right_leg.rotation.x = step;
    if (p.left_leg) p.left_leg.rotation.x = -step;
    if (p.head) { p.head.rotation.z += sin(t.age * 0.15) * 0.12; p.head.position.y += sin(t.age * 0.2) * 0.15 * S; }
    if (p.tail) p.tail.rotation.x = 1.0 + sin(t.age * 0.2) * 0.1 + (flying ? 0.3 : 0);
    if (e.dancing) {
      if (p.body) p.body.rotation.z = sin(t.age * 0.5) * 0.35;
      if (p.head) p.head.rotation.z += sin(t.age * 0.5) * 0.4;
    }
  },
});

defineModel('bat', {
  skin: 'bat',
  parts: [
    P('head', 0, 16, 0, [bx(-3, -3, -3, 6, 6, 6, 0, 0)], {
      children: [
        P('right_ear', 0, 0, 0, [bx(-4, -9, -1, 3, 6, 1, 24, 0)]),
        P('left_ear', 0, 0, 0, [bx(1, -9, -1, 3, 6, 1, 24, 0)]),
      ],
    }),
    P('body', 0, 16, 0, [bx(-3, 4, -3, 6, 12, 6, 0, 16)]),
    P('right_wing', -3, 16, 0, [bx(-12, 0, 0, 10, 16, 1, 42, 0)], {
      children: [P('right_wing_tip', -12, 0, 0, [bx(-8, 0, 0, 8, 12, 1, 24, 16)])],
    }),
    P('left_wing', 3, 16, 0, [bx(2, 0, 0, 10, 16, 1, 42, 0)], {
      children: [P('left_wing_tip', 12, 0, 0, [bx(0, 0, 0, 8, 12, 1, 24, 16)])],
    }),
  ],
  animate: (p, e, t) => {
    if (e.hanging || e.resting) {
      // Roosting upside down under the ceiling.
      if (p.head) p.head.rotation.x = t.headPitch;
      if (p.right_wing) { p.right_wing.rotation.y = 0.15; p.right_wing.rotation.z = -PI / 2 + 0.4; }
      if (p.left_wing) { p.left_wing.rotation.y = -0.15; p.left_wing.rotation.z = PI / 2 - 0.4; }
      if (p.right_wing_tip) p.right_wing_tip.rotation.z = -0.4;
      if (p.left_wing_tip) p.left_wing_tip.rotation.z = 0.4;
      return;
    }
    look(p, t);
    const f = sin(t.age * 0.9);
    if (p.right_wing) { p.right_wing.rotation.y = 0.2 + f * 0.35; p.right_wing.rotation.z = f * 0.9 - 0.3; }
    if (p.left_wing) { p.left_wing.rotation.y = -0.2 - f * 0.35; p.left_wing.rotation.z = -f * 0.9 + 0.3; }
    if (p.right_wing_tip) p.right_wing_tip.rotation.z = f * 0.8 - 0.4;
    if (p.left_wing_tip) p.left_wing_tip.rotation.z = -f * 0.8 + 0.4;
    if (p.body) p.body.rotation.x = 0.2 + sin(t.age * 0.9) * 0.1;
  },
});

defineModel('bee', {
  skin: 'bee',
  parts: [
    P('body', 0, 5, 0, [bx(-3.5, -4, -5, 7, 7, 10, 0, 0)], {
      children: [
        P('stinger', 0, 0, 0, [bx(0, -1, 5, 0, 1, 2, 26, 7)]),
        P('right_antenna', 0, 0, 0, [bx(-3, -4, -8, 1, 2, 3, 2, 0)]),
        P('left_antenna', 0, 0, 0, [bx(2, -4, -8, 1, 2, 3, 2, 3)]),
      ],
    }),
    P('right_wing', -1.5, 9, -3, [bxu(-9, 0, 0, 9, 0, 6, 0, 18, 9, 0, 6)], { alpha: true, rot: [0, -0.25, 0] }),
    P('left_wing', 1.5, 9, -3, [bxu(0, 0, 0, 9, 0, 6, 0, 18, 9, 0, 6)], { alpha: true, rot: [0, 0.25, 0] }),
    P('front_legs', 0, 1, -3, [bx(-5, 0, 0, 10, 2, 0, 26, 1)]),
    P('middle_legs', 0, 1, 0, [bx(-5, 0, 0, 10, 2, 0, 26, 3)]),
    P('back_legs', 0, 1, 3, [bx(-5, 0, 0, 10, 2, 0, 26, 5)]),
  ],
  animate: (p, e, t) => {
    look(p, t, 'body');
    const flying = !t.onGround;
    const beat = flying ? sin(t.age * 2.7) : 0;
    if (p.right_wing) { p.right_wing.rotation.y = -0.25 - beat * 0.45; p.right_wing.rotation.z = -beat * 0.5; }
    if (p.left_wing) { p.left_wing.rotation.y = 0.25 + beat * 0.45; p.left_wing.rotation.z = beat * 0.5; }
    if (p.body) {
      p.body.position.y += sin(t.age * 0.25) * 0.5 * S;
      p.body.rotation.x = flying ? -0.15 + sin(t.age * 0.25) * 0.06 : 0;
    }
    const legDrop = flying ? 0.6 : 0;
    if (p.front_legs) p.front_legs.rotation.x = legDrop;
    if (p.middle_legs) p.middle_legs.rotation.x = legDrop;
    if (p.back_legs) p.back_legs.rotation.x = legDrop;
    const twitch = sin(t.age * 0.3) * 0.15;
    if (p.right_antenna) p.right_antenna.rotation.x = twitch;
    if (p.left_antenna) p.left_antenna.rotation.x = -twitch;
    if (p.stinger) p.stinger.visible = !e.stingerless;
  },
});

/** Chain of body segments that ripple - silverfish, endermite, sculk critters. */
function segmentedParts(n, o) {
  const parts = [];
  const w = o.w, h = o.h, d = o.d, taper = o.taper || 0.75;
  let z = o.z0 || -4;
  for (let i = 0; i < n; i++) {
    const k = i === 0 ? 1 : Math.pow(taper, i - 1);
    const sw = Math.max(1, w * k), sh = Math.max(1, h * k), sd = Math.max(1, d * k);
    parts.push(P('segment' + i, 0, o.y, z + sd / 2,
      [bxu(-sw / 2, -sh, -sd / 2, sw, sh, sd, o.u || 0, o.v || 0, 4, 3, 3)]));
    z += sd;
  }
  return parts;
}
defineModel('silverfish', {
  skin: 'silverfish',
  parts: segmentedParts(5, { w: 4, h: 3, d: 3, y: 3, z0: -5 }).concat([
    P('legs0', 0, 1, -3, [bxu(-5, 0, -0.5, 10, 1, 1, 0, 0, 10, 1, 1)]),
    P('legs1', 0, 1, 0, [bxu(-5, 0, -0.5, 10, 1, 1, 0, 0, 10, 1, 1)]),
    P('legs2', 0, 1, 3, [bxu(-4, 0, -0.5, 8, 1, 1, 0, 0, 8, 1, 1)]),
  ]),
  animate: (p, e, t) => {
    // A travelling wave down the body sells the scuttle.
    for (let i = 0; i < 6; i++) {
      const s = p['segment' + i];
      if (!s) continue;
      const ph = t.age * 0.5 - i * 0.9;
      s.rotation.y = sin(ph) * 0.35 * (0.3 + t.limbSwingAmount);
      s.position.y += Math.abs(sin(ph)) * 0.3 * S * (0.3 + t.limbSwingAmount);
    }
    if (p.segment0) { p.segment0.rotation.y += t.headYaw * 0.4; p.segment0.rotation.x = t.headPitch * 0.3; }
    for (let i = 0; i < 3; i++) {
      const l = p['legs' + i];
      if (l) l.rotation.z = sin(t.age * 0.9 + i * 2) * 0.3 * (0.3 + t.limbSwingAmount);
    }
  },
});
defineModel('endermite', {
  skin: 'endermite',
  parts: segmentedParts(4, { w: 4, h: 3, d: 3, y: 3, z0: -4, taper: 0.7 }),
  animate: MODELS.silverfish.animate,
});

// ===========================================================================
// Aquatic life
// ===========================================================================

function squidParts(tentLen) {
  const parts = [P('body', 0, 12, 0, [bxu(-6, -8, -6, 12, 16, 12, 0, 0, 12, 16, 12)])];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * PI * 2;
    parts.push(P('tentacle' + i, cos(a) * 5, 4, sin(a) * 5,
      [bxu(-1, 0, -1, 2, tentLen, 2, 48, 0, 2, 18, 2)],
      { rot: [0, -a, 0] }));
  }
  return parts;
}
function animSquid(p, e, t) {
  const swim = t.inWater ? 1 : 0.4;
  // Tentacles undulate outward in a travelling ring, mantle pulses in sync.
  for (let i = 0; i < 8; i++) {
    const tent = p['tentacle' + i];
    if (!tent) continue;
    const ph = t.age * 0.18 - i * 0.35;
    tent.rotation.x = (0.15 + sin(ph) * 0.55) * swim;
    tent.rotation.z = sin(ph * 0.5) * 0.12 * swim;
  }
  if (p.body) {
    p.body.rotation.x = (e.tiltX !== undefined ? e.tiltX : 0) + sin(t.age * 0.09) * 0.05;
    const pulse = 1 + sin(t.age * 0.18) * 0.05 * swim;
    p.body.scale.set(pulse, 2 - pulse, pulse);
    p.body.position.y += sin(t.age * 0.18) * 0.6 * S;
  }
}
defineModel('squid', { skin: 'squid', scale: 0.62, parts: squidParts(16), animate: animSquid });
defineModel('glow_squid', { skin: 'glow_squid', scale: 0.62, parts: squidParts(16), animate: animSquid });

/** Cod-shaped fish: one body, a swinging tail fin and small side fins. */
function fishParts(o) {
  o = o || {};
  const bw = o.w || 2, bh = o.h || 4, bl = o.l || 7;
  return [
    P('body', 0, 4, 0, [bxu(-bw / 2, -bh / 2, -bl / 2, bw, bh, bl, 0, 0, 2, 4, 7)], {
      children: [
        P('top_fin', 0, bh / 2, 0, [bxu(0, 0, -bl / 2 + 1, 0, 2, bl - 2, 0, 0, 0, 2, 5)]),
        P('right_fin', -bw / 2, 0, -bl / 4, [bxu(-2, 0, -1, 2, 0, 2, 0, 0, 2, 0, 2)], { rot: [0, 0, -0.3] }),
        P('left_fin', bw / 2, 0, -bl / 4, [bxu(0, 0, -1, 2, 0, 2, 0, 0, 2, 0, 2)], { rot: [0, 0, 0.3] }),
      ],
    }),
    P('tail_fin', 0, 4, bl / 2, [bxu(0, -bh / 2, 0, 0, bh, o.tail || 4, 20, 3, 0, 4, 4)]),
  ];
}
function animFish(p, e, t) {
  const active = t.inWater ? 1 : 0.25;
  const s = sin(t.age * 0.6) * (0.25 + t.limbSwingAmount * 0.9) * active;
  if (p.tail_fin) p.tail_fin.rotation.y = s;
  if (p.body) {
    p.body.rotation.y = s * 0.25 + t.headYaw * 0.3;
    p.body.rotation.x = t.headPitch * 0.4;
    if (!t.inWater) {
      // Flopping on land.
      p.body.rotation.z = sin(t.age * 0.9) * 0.9;
      p.body.position.y -= 1 * S;
    }
  }
  if (p.right_fin) p.right_fin.rotation.y = -s * 0.5;
  if (p.left_fin) p.left_fin.rotation.y = s * 0.5;
}
defineModel('cod', { skin: 'cod', parts: fishParts({}), animate: animFish });
defineModel('salmon', {
  skin: 'salmon',
  parts: [
    P('body', 0, 5, -2, [bxu(-1.5, -3, -4, 3, 6, 8, 0, 0, 2, 4, 7)], {
      children: [P('top_fin', 0, 3, -1, [bxu(0, 0, -3, 0, 2, 6, 0, 0, 0, 2, 6)])],
    }),
    P('body_back', 0, 5, 2, [bxu(-1.5, -3, 0, 3, 6, 6, 0, 0, 2, 4, 7)], {
      children: [P('tail_fin', 0, 0, 6, [bxu(0, -3, 0, 0, 6, 5, 20, 3, 0, 4, 4)])],
    }),
    P('right_fin', -1.5, 5, -2, [bxu(-2, 0, -1, 2, 0, 2, 0, 0, 2, 0, 2)], { rot: [0, 0, -0.3] }),
    P('left_fin', 1.5, 5, -2, [bxu(0, 0, -1, 2, 0, 2, 0, 0, 2, 0, 2)], { rot: [0, 0, 0.3] }),
  ],
  animate: (p, e, t) => {
    const active = t.inWater ? 1 : 0.25;
    const s = sin(t.age * 0.5) * (0.25 + t.limbSwingAmount * 0.8) * active;
    if (p.body) { p.body.rotation.y = s * 0.4 + t.headYaw * 0.3; p.body.rotation.x = t.headPitch * 0.4; }
    if (p.body_back) p.body_back.rotation.y = sin(t.age * 0.5 - 0.8) * (0.35 + t.limbSwingAmount) * active;
    if (p.tail_fin) p.tail_fin.rotation.y = sin(t.age * 0.5 - 1.4) * (0.4 + t.limbSwingAmount) * active;
    if (!t.inWater && p.body) p.body.rotation.z = sin(t.age * 0.9) * 0.8;
  },
});
defineModel('tropical_fish', {
  skin: 'tropical_fish', scale: 0.8,
  parts: [
    P('body', 0, 4, 0, [bxu(-1, -3, -3, 2, 6, 6, 0, 0, 2, 4, 7)], {
      children: [
        P('top_fin', 0, 3, 0, [bxu(0, 0, -2, 0, 4, 5, 0, 0, 0, 4, 5)]),
        P('bottom_fin', 0, -3, 0, [bxu(0, -4, -2, 0, 4, 5, 0, 0, 0, 4, 5)]),
        P('right_fin', -1, 0, -1, [bxu(-3, 0, -1, 3, 0, 3, 0, 0, 3, 0, 3)], { rot: [0, 0, -0.35] }),
        P('left_fin', 1, 0, -1, [bxu(0, 0, -1, 3, 0, 3, 0, 0, 3, 0, 3)], { rot: [0, 0, 0.35] }),
      ],
    }),
    P('tail_fin', 0, 4, 3, [bxu(0, -3, 0, 0, 6, 5, 20, 3, 0, 4, 4)]),
  ],
  animate: animFish,
});
defineModel('pufferfish', {
  skin: 'pufferfish',
  parts: [
    P('body', 0, 4, 0, [bxu(-2.5, -2.5, -2.5, 5, 5, 5, 0, 0, 5, 5, 5)], {
      children: [
        P('spikes', 0, 0, 0, [
          bxu(-3.5, -1, -1, 7, 2, 2, 0, 0, 7, 2, 2),
          bxu(-1, -3.5, -1, 2, 7, 2, 0, 0, 2, 7, 2),
          bxu(-1, -1, -3.5, 2, 2, 7, 0, 0, 2, 2, 7),
        ], { visible: false }),
        P('right_fin', -2.5, 0, -1, [bxu(-2, 0, -1, 2, 0, 2, 0, 0, 2, 0, 2)]),
        P('left_fin', 2.5, 0, -1, [bxu(0, 0, -1, 2, 0, 2, 0, 0, 2, 0, 2)]),
      ],
    }),
    P('tail_fin', 0, 4, 2.5, [bxu(0, -2, 0, 0, 4, 4, 20, 3, 0, 4, 4)]),
  ],
  animate: (p, e, t) => {
    animFish(p, e, t);
    const puff = clamp((e.puffState !== undefined ? e.puffState : 0) / 2, 0, 1);
    if (p.body) p.body.scale.setScalar(1 + puff * 0.9);
    if (p.spikes) { p.spikes.visible = puff > 0.05; p.spikes.scale.setScalar(0.4 + puff * 0.8); }
  },
});
defineModel('dolphin', {
  skin: 'dolphin',
  parts: [
    P('body', 0, 8, 0, [bxu(-4, -4, -8, 8, 7, 13, 0, 0, 8, 7, 13)], {
      children: [
        P('dorsal_fin', 0, 4, -2, [bxu(-0.5, -3, 0, 1, 3, 4, 0, 0, 1, 3, 4)], { rot: [-0.35, 0, 0] }),
        P('right_flipper', -4, -1, -4, [bxu(-6, 0, -1, 6, 1, 4, 0, 0, 6, 1, 4)], { rot: [0, 0, -0.6] }),
        P('left_flipper', 4, -1, -4, [bxu(0, 0, -1, 6, 1, 4, 0, 0, 6, 1, 4)], { rot: [0, 0, 0.6] }),
      ],
    }),
    P('head', 0, 8, -8, [bxu(-3, -3, -6, 6, 5, 6, 0, 0, 6, 5, 6)], {
      children: [P('snout', 0, -1, -6, [bxu(-1.5, 0, -3, 3, 2, 3, 0, 0, 3, 2, 3)])],
    }),
    P('tail', 0, 8, 5, [bxu(-3, -2.5, 0, 6, 5, 6, 0, 0, 6, 5, 6)], {
      children: [P('tail_fin', 0, 0, 6, [bxu(-5, -0.5, 0, 10, 1, 4, 0, 0, 10, 1, 4)])],
    }),
  ],
  animate: (p, e, t) => {
    look(p, t);
    // Dolphins pump vertically, not side-to-side.
    const s = sin(t.age * 0.4) * (0.25 + t.limbSwingAmount * 0.8) * (t.inWater ? 1 : 0.3);
    if (p.tail) p.tail.rotation.x = s * 0.6;
    if (p.tail_fin) p.tail_fin.rotation.x = sin(t.age * 0.4 - 0.7) * (0.3 + t.limbSwingAmount) * 0.6;
    if (p.body) p.body.rotation.x = -s * 0.15 + t.headPitch * 0.3;
    if (p.right_flipper) p.right_flipper.rotation.x = s * 0.5;
    if (p.left_flipper) p.left_flipper.rotation.x = -s * 0.5;
  },
});

function guardianParts() {
  const parts = [
    P('body', 0, 12, 0, [bxu(-6, -6, -6, 12, 12, 12, 0, 0, 12, 12, 12)], {
      children: [
        P('eye', 0, 0, 0, [bxu(-1, -1, -6.6, 2, 2, 1, 12, 12, 2, 2, 1)], { bright: true }),
      ],
    }),
    P('tail0', 0, 12, 6, [bxu(-2, -2, 0, 4, 4, 8, 0, 0, 4, 4, 8)], {
      children: [
        P('tail1', 0, 0, 8, [bxu(-1.5, -1.5, 0, 3, 3, 7, 0, 0, 3, 3, 7)], {
          children: [P('tail2', 0, 0, 7, [bxu(0, -3, 0, 0, 6, 6, 0, 0, 0, 6, 6)])],
        }),
      ],
    }),
  ];
  // Six retractable spikes, one out of each face. The box hangs downward from
  // its pivot, so each entry rotates that -Y direction onto the face normal.
  const dirs = [
    [0, 1, 0, PI, 0], [0, -1, 0, 0, 0],
    [1, 0, 0, 0, HALF_PI], [-1, 0, 0, 0, -HALF_PI],
    [0, 0, 1, -HALF_PI, 0], [0, 0, -1, HALF_PI, 0],
  ];
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    parts.push(P('spike' + i, d[0] * 5.5, 12 + d[1] * 5.5, d[2] * 5.5,
      [bxu(-1, 0, -1, 2, 6, 2, 0, 0, 2, 6, 2)],
      { rot: [d[3], 0, d[4]] }));
  }
  return parts;
}
function animGuardian(p, e, t) {
  const ext = e.spikesOut !== undefined ? clamp(e.spikesOut, 0, 1) : (e.target ? 1 : 0.35);
  for (let i = 0; i < 6; i++) {
    const s = p['spike' + i];
    if (!s) continue;
    const f = 0.25 + ext * 0.75 + sin(t.age * 0.12 + i) * 0.06;
    s.scale.set(1, f, 1);
  }
  const swim = t.inWater ? 1 : 0.3;
  if (p.tail0) p.tail0.rotation.y = sin(t.age * 0.16) * 0.35 * swim;
  if (p.tail1) p.tail1.rotation.y = sin(t.age * 0.16 - 0.7) * 0.45 * swim;
  if (p.tail2) p.tail2.rotation.y = sin(t.age * 0.16 - 1.4) * 0.55 * swim;
  if (p.body) {
    p.body.rotation.y = t.headYaw;
    p.body.rotation.x = t.headPitch;
    p.body.position.y += sin(t.age * 0.08) * 0.8 * S;
  }
  if (p.eye) {
    // The eye slides toward whatever the guardian is staring at.
    p.eye.position.x = clamp(t.headYaw, -0.6, 0.6) * 1.5 * S;
    p.eye.position.y = clamp(-t.headPitch, -0.6, 0.6) * 1.5 * S;
    p.eye.visible = !e.beaming || (t.age % 4) < 3;
  }
}
defineModel('guardian', { skin: 'guardian', parts: guardianParts(), animate: animGuardian });
defineModel('elder_guardian', { skin: 'elder_guardian', scale: 2.35, parts: guardianParts(), animate: animGuardian });

// ===========================================================================
// Monsters
// ===========================================================================

defineModel('creeper', {
  skin: 'creeper',
  parts: [
    P('head', 0, 18, 0, [bx(-4, -8, -4, 8, 8, 8, 0, 0)], {
      children: [P('hat', 0, 0, 0, [bxu(-4, -8, -4, 8, 8, 8, 32, 0, 8, 8, 8, 0.5)], { alpha: true, visible: false })],
    }),
    P('body', 0, 18, 0, [bx(-4, 0, -2, 8, 12, 4, 16, 16)]),
    P('right_front_leg', -2, 6, -4, [bx(-2, 0, -2, 4, 6, 4, 0, 16)]),
    P('left_front_leg', 2, 6, -4, [bx(-2, 0, -2, 4, 6, 4, 0, 16)]),
    P('right_hind_leg', -2, 6, 4, [bx(-2, 0, -2, 4, 6, 4, 0, 16)]),
    P('left_hind_leg', 2, 6, 4, [bx(-2, 0, -2, 4, 6, 4, 0, 16)]),
  ],
  animate: (p, e, t) => {
    look(p, t);
    const a = cos(t.limbSwing * 0.6662) * 1.4 * t.limbSwingAmount;
    if (p.right_front_leg) p.right_front_leg.rotation.x = a;
    if (p.left_front_leg) p.left_front_leg.rotation.x = -a;
    if (p.right_hind_leg) p.right_hind_leg.rotation.x = -a;
    if (p.left_hind_leg) p.left_hind_leg.rotation.x = a;
    // Ignition: the creeper swells and its plates separate.
    const swell = clamp(e.swell !== undefined ? e.swell : ((e.fuseTicks || 0) / 30), 0, 1);
    if (swell > 0) {
      const f = swell * swell;
      const jitter = 1 + sin(f * 100) * 0.01;
      const s = 1 + f * 0.45;
      if (p.body) { p.body.scale.set(s * jitter, 1 + f * 0.25, s * jitter); }
      if (p.head) { p.head.scale.setScalar(1 + f * 0.3); p.head.position.y += f * 1.5 * S; }
      for (const k of ['right_front_leg', 'left_front_leg', 'right_hind_leg', 'left_hind_leg']) {
        if (p[k]) { p[k].position.x *= 1 + f * 0.5; p[k].position.z *= 1 + f * 0.5; }
      }
    }
    if (e.charged || e.powered) { if (p.hat) p.hat.visible = true; }
  },
});

function spiderParts(o) {
  o = o || {};
  const parts = [
    P('head', 0, 9, -3, [bx(-4, -4, -8, 8, 8, 8, 32, 4)]),
    P('thorax', 0, 9, 0, [bx(-3, -3, -3, 6, 6, 6, 0, 0)]),
    P('abdomen', 0, 9, 9, [bx(-5, -4, -6, 10, 8, 12, 0, 12)]),
  ];
  // Four pairs of 16-long legs, mirrored across X and spread along Z.
  const zs = [2, 1, 0, -1];
  const zBase = [-1, 0, 1, 2];
  for (let i = 0; i < 4; i++) {
    parts.push(P('right_leg' + i, -4, 9, zs[i] + zBase[i] * 0,
      [bxu(-15, -1, -1, 16, 2, 2, 18, 0, 16, 2, 2)],
      { rot: [0, -0.7853 + i * 0.5236, -0.7853 + i * 0.1] }));
    parts.push(P('left_leg' + i, 4, 9, zs[i],
      [bxu(-1, -1, -1, 16, 2, 2, 18, 0, 16, 2, 2)],
      { rot: [0, 0.7853 - i * 0.5236, 0.7853 - i * 0.1] }));
  }
  return parts;
}
function animSpider(p, e, t) {
  if (p.head) { p.head.rotation.y = t.headYaw; p.head.rotation.x = t.headPitch; }
  // Four phase-offset pairs: legs splay outward and scuttle.
  const amt = 0.3 + t.limbSwingAmount * 0.9;
  for (let i = 0; i < 4; i++) {
    const ph = t.limbSwing * 0.6662 + i * (PI / 2);
    const lift = cos(ph) * 0.4 * t.limbSwingAmount;
    const sweep = Math.abs(sin(ph)) * 0.5 * t.limbSwingAmount;
    const baseZ = 0.7853 - i * 0.1;
    const baseY = 0.7853 - i * 0.5236;
    const r = p['right_leg' + i], l = p['left_leg' + i];
    if (r) {
      r.rotation.z = -baseZ - lift * amt;
      r.rotation.y = -baseY + sweep;
    }
    if (l) {
      l.rotation.z = baseZ + lift * amt;
      l.rotation.y = baseY - sweep;
    }
  }
  if (p.abdomen) p.abdomen.rotation.x = sin(t.age * 0.08) * 0.04 - t.limbSwingAmount * 0.08;
  if (p.thorax) p.thorax.position.y += Math.abs(sin(t.limbSwing * 0.6662)) * t.limbSwingAmount * 0.4 * S;
}
defineModel('spider', { skin: 'spider', parts: spiderParts(), animate: animSpider });
defineModel('cave_spider', { skin: 'cave_spider', scale: 0.7, parts: spiderParts(), animate: animSpider });

defineModel('enderman', {
  skin: 'enderman',
  parts: [
    P('head', 0, 42, 0, [bx(-4, -8, -4, 8, 8, 8, 0, 0)], {
      children: [
        P('hat', 0, 0, 0, [bxu(-4, -8, -4, 8, 8, 8, 32, 0, 8, 8, 8, 0.5)], { alpha: true }),
        P('mouth', 0, 0, 0, [bxu(-2, -3, -4.6, 4, 2, 1, 8, 8, 4, 2, 1)], { bright: true, visible: false }),
      ],
    }),
    P('body', 0, 42, 0, [bx(-4, 0, -2, 8, 12, 4, 32, 16)]),
    P('right_arm', -5, 40, 0, [bxu(-1, -2, -1, 2, 30, 2, 56, 0, 4, 12, 4)]),
    P('left_arm', 5, 40, 0, [bxu(-1, -2, -1, 2, 30, 2, 56, 0, 4, 12, 4)]),
    P('right_leg', -2, 30, 0, [bxu(-1, 0, -1, 2, 30, 2, 56, 0, 4, 12, 4)]),
    P('left_leg', 2, 30, 0, [bxu(-1, 0, -1, 2, 30, 2, 56, 0, 4, 12, 4)]),
  ],
  animate: (p, e, t) => {
    look(p, t);
    walk(p, t, 0.9, 0.6);
    const angry = !!(e.angry || e.screaming || e.target);
    if (p.mouth) p.mouth.visible = angry;
    if (angry) {
      // Aggro: arms come up, jaw drops, whole body shakes.
      if (p.right_arm) { p.right_arm.rotation.x -= 0.8 + sin(t.age * 0.4) * 0.2; p.right_arm.rotation.z = -0.15; }
      if (p.left_arm) { p.left_arm.rotation.x -= 0.8 + sin(t.age * 0.4 + 1) * 0.2; p.left_arm.rotation.z = 0.15; }
      if (p.body) p.body.rotation.z = sin(t.age * 1.1) * 0.03;
      if (p.head) p.head.rotation.z = sin(t.age * 1.3) * 0.05;
    } else {
      // Idle: long arms hang and sway.
      if (p.right_arm) { p.right_arm.rotation.x = sin(t.age * 0.05) * 0.1; p.right_arm.rotation.z = -0.05 + cos(t.age * 0.09) * 0.05; }
      if (p.left_arm) { p.left_arm.rotation.x = sin(t.age * 0.05 + PI) * 0.1; p.left_arm.rotation.z = 0.05 - cos(t.age * 0.09) * 0.05; }
    }
    if (e.carrying || e.heldBlock) { if (p.right_arm) p.right_arm.rotation.x -= 0.6; if (p.left_arm) p.left_arm.rotation.x -= 0.6; }
  },
});

function slimeParts() {
  return [
    P('body', 0, 4, 0, [bxu(-4, 0, -4, 8, 8, 8, 0, 16, 6, 6, 6)], {
      children: [
        P('right_eye', 0, 0, 0, [bxu(-3.25, -6, -4.5, 2, 2, 1, 32, 0, 2, 2, 1)], { bright: true }),
        P('left_eye', 0, 0, 0, [bxu(1.25, -6, -4.5, 2, 2, 1, 32, 4, 2, 2, 1)], { bright: true }),
        P('mouth', 0, 0, 0, [bxu(-0.5, -3, -4.5, 1, 1, 1, 32, 8, 1, 1, 1)]),
      ],
    }),
    P('shell', 0, 4, 0, [bxu(-4, 0, -4, 8, 8, 8, 0, 0, 8, 8, 8, 0.25)], { alpha: true }),
  ];
}
function animSlime(p, e, t) {
  // Squash and stretch driven by vertical velocity, with a residual wobble.
  const v = clamp(t.vy * 0.12, -0.6, 0.6);
  const land = e.squish !== undefined ? e.squish : 0;
  const wob = sin(t.age * 0.35) * 0.05;
  const sy = clamp(1 + v * 0.6 - land * 0.4 + wob, 0.55, 1.5);
  const sxz = 1 / Math.sqrt(sy);
  if (p.body) { p.body.scale.set(sxz, sy, sxz); p.body.rotation.y = t.headYaw * 0.5; }
  if (p.shell) { p.shell.scale.set(sxz * 1.02, sy * 1.02, sxz * 1.02); p.shell.rotation.y = t.headYaw * 0.5; }
}
defineModel('slime', { skin: 'slime', parts: slimeParts(), animate: animSlime });
defineModel('magma_cube', {
  skin: 'magma_cube',
  parts: [
    P('body', 0, 4, 0, [bxu(-4, 0, -4, 8, 8, 8, 0, 16, 6, 6, 6)], {
      children: [
        P('right_eye', 0, 0, 0, [bxu(-3.25, -6, -4.5, 2, 2, 1, 32, 0, 2, 2, 1)], { bright: true }),
        P('left_eye', 0, 0, 0, [bxu(1.25, -6, -4.5, 2, 2, 1, 32, 4, 2, 2, 1)], { bright: true }),
      ],
    }),
    P('segment0', 0, 8, 0, [bxu(-4, 0, -4, 8, 3, 8, 0, 0, 8, 3, 8, 0.2)]),
    P('segment1', 0, 5, 0, [bxu(-4, 0, -4, 8, 3, 8, 0, 0, 8, 3, 8, 0.2)]),
    P('segment2', 0, 2, 0, [bxu(-4, 0, -4, 8, 3, 8, 0, 0, 8, 3, 8, 0.2)]),
  ],
  animate: (p, e, t) => {
    animSlime(p, e, t);
    // The crust splits open as the cube stretches after a bounce.
    const gap = clamp(-t.vy * 0.05, 0, 0.6) + Math.abs(sin(t.age * 0.2)) * 0.08;
    if (p.segment0) p.segment0.position.y += gap * 2 * S;
    if (p.segment1) p.segment1.position.y += gap * 1 * S;
    if (p.segment2) p.segment2.position.y -= gap * 0.5 * S;
  },
});

defineModel('blaze', {
  skin: 'blaze',
  parts: (() => {
    const parts = [P('head', 0, 20, 0, [bx(-4, -4, -4, 8, 8, 8, 0, 0)])];
    for (let i = 0; i < 12; i++) {
      parts.push(P('rod' + i, 0, 20, 0, [bxu(-1, 0, -1, 2, 8, 2, 0, 16, 2, 8, 2)], { bright: true }));
    }
    return parts;
  })(),
  animate: (p, e, t) => {
    look(p, t);
    if (p.head) p.head.position.y += sin(t.age * 0.06) * 0.6 * S;
    // Three rings of four rods, each ring at its own radius, height and speed.
    for (let i = 0; i < 12; i++) {
      const rod = p['rod' + i];
      if (!rod) continue;
      const ring = (i / 4) | 0;
      const idx = i % 4;
      const speed = [0.06, -0.09, 0.13][ring];
      const radius = [6, 4.5, 3][ring];
      const yOff = [-8, -3, 2][ring];
      const a = t.age * speed + idx * HALF_PI + ring * 0.6;
      rod.position.set(cos(a) * radius * S, (20 + yOff + sin(t.age * 0.1 + i) * 0.8) * S, sin(a) * radius * S);
      rod.rotation.set(sin(t.age * 0.08 + i) * 0.15, -a, cos(t.age * 0.07 + i) * 0.15);
      rod.scale.setScalar(0.85 + sin(t.age * 0.15 + i) * 0.15);
    }
  },
});

defineModel('ghast', {
  skin: 'ghast', scale: 2.2,
  parts: (() => {
    const parts = [P('body', 0, 12, 0, [bx(-8, -8, -8, 16, 16, 16, 0, 0)])];
    // Nine tentacles in a 3x3 grid under the body, each a different length.
    for (let i = 0; i < 9; i++) {
      const gx = (i % 3) - 1, gz = ((i / 3) | 0) - 1;
      parts.push(P('tentacle' + i, gx * 5, 4, gz * 5,
        [bxu(-1, 0, -1, 2, 9 + (i % 3) * 2, 2, 0, 0, 2, 9, 2)]));
    }
    return parts;
  })(),
  animate: (p, e, t) => {
    if (p.body) {
      p.body.rotation.y = t.headYaw;
      p.body.rotation.x = t.headPitch * 0.5;
      p.body.position.y += sin(t.age * 0.04) * 1.2 * S;
    }
    // Tentacles trail behind, each lagging a little further than the last.
    for (let i = 0; i < 9; i++) {
      const tent = p['tentacle' + i];
      if (!tent) continue;
      tent.rotation.x = 0.2 + sin(t.age * 0.06 + i * 0.7) * 0.25;
      tent.rotation.z = sin(t.age * 0.05 + i * 1.1) * 0.2;
    }
    if (e.charging || e.attacking) {
      if (p.body) p.body.scale.setScalar(1 + sin(t.age * 0.5) * 0.03);
    }
  },
});

defineModel('shulker', {
  skin: 'shulker',
  parts: [
    P('base', 0, 0, 0, [bxu(-8, 0, -8, 16, 8, 16, 0, 28, 8, 8, 8)]),
    P('lid', 0, 8, 0, [bxu(-8, 0, -8, 16, 12, 16, 0, 0, 8, 8, 8)]),
    P('head', 0, 8, 0, [bxu(-3, 0, -3, 6, 6, 6, 0, 52, 6, 6, 6)]),
  ],
  animate: (p, e, t) => {
    const peek = clamp(e.peek !== undefined ? e.peek : (e.target ? 0.6 : 0.05), 0, 1);
    if (p.lid) p.lid.position.y += peek * 8 * S;
    if (p.head) {
      p.head.position.y += peek * 6 * S;
      p.head.rotation.y = t.headYaw + t.age * 0.02 * (peek > 0.2 ? 1 : 0);
    }
    if (p.base) p.base.rotation.y = 0;
  },
});

defineModel('phantom', {
  skin: 'phantom', scale: 1.2,
  parts: [
    P('body', 0, 8, 0, [bx(-3, -2, -8, 5, 3, 9, 0, 8)], {
      children: [
        P('head', 0, 0, -8, [bxu(-4, -3, -6, 7, 3, 5, 0, 0, 7, 3, 5)]),
        P('tail0', 0, -1, 1, [bxu(-2, 0, 0, 3, 2, 6, 3, 20, 3, 2, 6)], {
          children: [P('tail1', 0, 0, 6, [bxu(-1, 0, 0, 1, 1, 6, 4, 29, 1, 1, 6)])],
        }),
      ],
    }),
    P('right_wing', -3, 8, -4, [bxu(-6, -1, -2, 6, 2, 8, 23, 12, 6, 2, 8)], {
      children: [P('right_wing_tip', -6, 0, 0, [bxu(-13, -0.5, -2, 13, 1, 9, 16, 24, 13, 1, 9)])],
    }),
    P('left_wing', 2, 8, -4, [bxu(0, -1, -2, 6, 2, 8, 23, 12, 6, 2, 8)], {
      children: [P('left_wing_tip', 6, 0, 0, [bxu(0, -0.5, -2, 13, 1, 9, 16, 24, 13, 1, 9)])],
    }),
  ],
  animate: (p, e, t) => {
    const f = sin(t.age * 0.38);
    if (p.right_wing) p.right_wing.rotation.z = -0.1 - f * 0.55;
    if (p.left_wing) p.left_wing.rotation.z = 0.1 + f * 0.55;
    if (p.right_wing_tip) p.right_wing_tip.rotation.z = -0.15 - sin(t.age * 0.38 - 0.6) * 0.7;
    if (p.left_wing_tip) p.left_wing_tip.rotation.z = 0.15 + sin(t.age * 0.38 - 0.6) * 0.7;
    if (p.tail0) p.tail0.rotation.x = sin(t.age * 0.2) * 0.15;
    if (p.tail1) p.tail1.rotation.x = sin(t.age * 0.2 - 0.8) * 0.25;
    if (p.head) p.head.rotation.x = t.headPitch * 0.5 + 0.1;
    if (p.body) { p.body.rotation.x = t.headPitch * 0.3; p.body.position.y += sin(t.age * 0.2) * 0.8 * S; }
  },
});

function winglingParts(o) {
  const parts = humanoidParts({ armW: 2, armD: 2, legW: 2, bodyH: 10, legLen: 6, outer: false });
  parts.push(P('right_wing', -1.5, 22, 2, [bxu(-6, -1, 0, 6, 12, 1, 0, 32, 6, 12, 1)], { alpha: true, rot: [0, 0.4, 0] }));
  parts.push(P('left_wing', 1.5, 22, 2, [bxu(0, -1, 0, 6, 12, 1, 0, 32, 6, 12, 1)], { alpha: true, rot: [0, -0.4, 0] }));
  return parts;
}
function animWingling(p, e, t) {
  look(p, t);
  const f = sin(t.age * 1.6);
  if (p.right_wing) { p.right_wing.rotation.y = 0.4 + f * 0.7; p.right_wing.rotation.z = -0.15; }
  if (p.left_wing) { p.left_wing.rotation.y = -0.4 - f * 0.7; p.left_wing.rotation.z = 0.15; }
  const hover = sin(t.age * 0.18) * 0.6 * S;
  if (p.body) p.body.position.y += hover;
  if (p.head) p.head.position.y += hover;
  // Legs dangle instead of walking.
  if (p.right_leg) { p.right_leg.rotation.x = 0.25 + sin(t.age * 0.12) * 0.08; }
  if (p.left_leg) { p.left_leg.rotation.x = 0.25 + sin(t.age * 0.12 + 0.6) * 0.08; }
  if (p.right_arm) p.right_arm.rotation.x = -0.2 + sin(t.age * 0.12) * 0.1;
  if (p.left_arm) p.left_arm.rotation.x = -0.2 + sin(t.age * 0.12 + 0.6) * 0.1;
  attackSwing(p, t, 'right_arm');
}
defineModel('vex', {
  skin: 'vex', scale: 0.6, parts: winglingParts({}),
  animate: (p, e, t) => {
    animWingling(p, e, t);
    if (e.charging || e.target) {
      if (p.right_arm) p.right_arm.rotation.x = -HALF_PI - 0.3;
      if (p.left_arm) p.left_arm.rotation.x = -HALF_PI - 0.3;
      if (p.body) p.body.rotation.x = 0.25;
    }
  },
});
defineModel('allay', {
  skin: 'allay', scale: 0.55, parts: winglingParts({}),
  animate: (p, e, t) => {
    animWingling(p, e, t);
    if (e.dancing) {
      if (p.body) p.body.rotation.z = sin(t.age * 0.35) * 0.3;
      if (p.right_arm) p.right_arm.rotation.z = -0.8 - sin(t.age * 0.35) * 0.4;
      if (p.left_arm) p.left_arm.rotation.z = 0.8 + sin(t.age * 0.35) * 0.4;
    } else if (e.holdingItem || e.heldItem) {
      if (p.right_arm) { p.right_arm.rotation.x = -1.5; p.right_arm.rotation.z = -0.3; }
      if (p.left_arm) { p.left_arm.rotation.x = -1.5; p.left_arm.rotation.z = 0.3; }
    }
  },
});
