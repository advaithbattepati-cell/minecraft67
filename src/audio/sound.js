// ============================================================================
// sound.js - Procedural WebAudio sound engine.
//
// No audio files, ever. Everything here is synthesised at play time from
// oscillators, cached noise buffers, biquad filters, wave shapers and a
// generated convolution impulse response.
//
// The module is safe to import before any user gesture: no AudioContext is
// constructed until SoundEngine.init() runs, and every public method swallows
// its own errors so a broken sound can never take the game down.
// ============================================================================
import { SOUND_CATEGORIES } from '../core/constants.js';
import { clamp } from '../core/util.js';
import { RNG, hashString } from '../core/rng.js';
import { Game } from '../core/game.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** name -> synth descriptor. */
export const SOUNDS = {};
/** Every registered sound name, in registration order. */
export const SOUND_NAMES = [];

/**
 * Registers a synthesised sound.
 * @param {string} name canonical snake_case sound name
 * @param {{synth:Function, volume?:number, pitchVariance?:number, category?:string,
 *          loop?:boolean, maxDist?:number, cooldown?:number, reverb?:number}} def
 * @returns {object} the stored descriptor
 */
export function defineSound(name, def) {
  const d = {
    name,
    synth: typeof def.synth === 'function' ? def.synth : () => 0,
    volume: def.volume ?? 1,
    pitchVariance: def.pitchVariance ?? 0,
    category: def.category || 'blocks',
    loop: !!def.loop,
    maxDist: def.maxDist ?? 16,
    cooldown: def.cooldown ?? 0.015,
    reverb: def.reverb ?? 0,
  };
  if (!(name in SOUNDS)) SOUND_NAMES.push(name);
  SOUNDS[name] = d;
  return d;
}

/** Shorthand used all over this file. */
const S = (name, category, volume, pitchVariance, synth, extra) =>
  defineSound(name, Object.assign({ category, volume, pitchVariance, synth }, extra));

/** Registers `name` as another spelling of an existing sound. */
function alias(name, target) {
  const d = SOUNDS[target];
  if (!d) return null;
  if (!(name in SOUNDS)) SOUND_NAMES.push(name);
  SOUNDS[name] = Object.assign({}, d, { name });
  return SOUNDS[name];
}

// Structured fallbacks so a name nobody registered still makes a plausible
// noise instead of silence (or a crash).
const FALLBACKS = [
  [/^(step|walk)_/, 'step_stone'],
  [/_(step|walk)$/, 'step_stone'],
  [/^(dig|break|destroy|mine)_/, 'dig_stone'],
  [/_(dig|break|destroy)$/, 'dig_stone'],
  [/^(place|put)_/, 'place_stone'],
  [/_place$/, 'place_stone'],
  [/_hit$/, 'step_stone'],
  [/_hurt$/, 'generic_hurt'],
  [/_death$/, 'generic_death'],
  [/_(idle|ambient|say|angry|celebrate)$/, 'generic_idle'],
  [/_(open|close)$/, 'click'],
  [/^music_disc/, 'music_disc_cat'],
  [/^note_/, 'note_harp'],
];

/** Resolves a sound name to a descriptor, applying fallbacks. Never throws. */
function resolve(name) {
  if (!name || typeof name !== 'string') return null;
  const direct = SOUNDS[name];
  if (direct) return direct;
  const dot = name.indexOf('.');
  if (dot >= 0) return resolve(name.slice(dot + 1).replace(/\./g, '_'));
  for (let i = 0; i < FALLBACKS.length; i++) {
    if (FALLBACKS[i][0].test(name)) {
      const d = SOUNDS[FALLBACKS[i][1]];
      if (d) return d;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Synthesis toolkit
// ---------------------------------------------------------------------------

const NOISE_SECONDS = 2;
const _banks = new WeakMap();

function bankOf(ctx) {
  let b = _banks.get(ctx);
  if (!b) { b = { noise: new Map(), ir: new Map(), curve: new Map() }; _banks.set(ctx, b); }
  return b;
}

/** Cached looping noise buffer. Colours: white, pink, brown, crackle, sparkle. */
function noiseBuffer(ctx, color = 'white') {
  const bank = bankOf(ctx);
  const hit = bank.noise.get(color);
  if (hit) return hit;
  const n = Math.max(1024, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rng = new RNG(hashString('mc67_noise_' + color));
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = clamp((b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.14, -1, 1);
      b6 = w * 0.115926;
    }
  } else if (color === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      last = (last + 0.021 * w) / 1.021;
      d[i] = clamp(last * 3.6, -1, 1);
    }
  } else if (color === 'crackle') {
    // Sparse decaying impulses - the backbone of fire and campfire loops.
    for (let i = 0; i < n; i++) d[i] = (rng.next() * 2 - 1) * 0.04;
    let i = 0;
    while (i < n) {
      i += 40 + rng.int(2200);
      const len = 30 + rng.int(420);
      const amp = 0.25 + rng.next() * 0.75;
      for (let k = 0; k < len && i + k < n; k++) {
        const e = Math.pow(1 - k / len, 3);
        d[i + k] = clamp(d[i + k] + (rng.next() * 2 - 1) * amp * e, -1, 1);
      }
      i += len;
    }
  } else if (color === 'sparkle') {
    // High, thin, intermittent - used for water, glass and magic textures.
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      d[i] = w * (0.15 + 0.85 * Math.pow(Math.abs(Math.sin(i * 0.0007)), 4));
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = rng.next() * 2 - 1;
  }
  bank.noise.set(color, buf);
  return buf;
}

/** Cached stereo impulse response: exponentially decaying noise + early taps. */
function reverbIR(ctx, seconds = 2.4, decay = 3.0) {
  const key = seconds + ':' + decay;
  const bank = bankOf(ctx);
  const hit = bank.ir.get(key);
  if (hit) return hit;
  const n = Math.max(256, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  const rng = new RNG(hashString('mc67_ir_' + key));
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (rng.next() * 2 - 1) * Math.pow(1 - t, decay) * 0.6;
    }
    for (let k = 0; k < 9; k++) {
      const pos = Math.floor((0.004 + rng.next() * 0.09) * ctx.sampleRate);
      if (pos < n) d[pos] += (rng.next() * 2 - 1) * 0.55 * Math.pow(0.72, k);
    }
  }
  bank.ir.set(key, buf);
  return buf;
}

/** Cached soft-clipping wave shaper curve. */
function distCurve(ctx, amount = 20) {
  const k = Math.max(0.001, amount);
  const key = 'd' + k.toFixed(2);
  const bank = bankOf(ctx);
  const hit = bank.curve.get(key);
  if (hit) return hit;
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  bank.curve.set(key, c);
  return c;
}

const pipe = (a, b) => { a.connect(b); return b; };

/** A biquad with an optional exponential frequency sweep across `dur`. */
function biquad(ctx, type, freq, q, t, dur, freq2) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q == null ? 1 : q;
  f.frequency.setValueAtTime(clamp(freq || 1000, 20, 20000), t);
  if (freq2 != null && isFinite(freq2)) {
    f.frequency.exponentialRampToValueAtTime(clamp(freq2, 20, 20000), t + Math.max(0.01, dur));
  }
  return f;
}

/**
 * ADSR gain node. `p.hold` makes it sustain forever (looping ambiences); the
 * engine releases those explicitly when the sound is stopped.
 */
function envGain(ctx, o, t, dur, p) {
  const g = ctx.createGain();
  const peak = Math.max(0.0003, p.gain == null ? 0.3 : p.gain);
  const a = Math.max(0.0006, p.a == null ? 0.005 : p.a);
  if (p.hold) {
    g.gain.setValueAtTime(0.0003, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    return g;
  }
  const r = Math.max(0.005, p.r == null ? 0.05 : p.r);
  const d = Math.max(0.001, p.d == null ? dur * 0.35 : p.d);
  const sus = Math.max(0.0002, p.s == null ? peak * 0.5 : p.s);
  const aT = t + Math.min(a, dur * 0.9);
  const end = t + dur;
  g.gain.setValueAtTime(0.0003, t);
  g.gain.linearRampToValueAtTime(peak, aT);
  if (aT + d < end) {
    g.gain.exponentialRampToValueAtTime(sus, aT + d);
    g.gain.setValueAtTime(sus, end);
  }
  g.gain.exponentialRampToValueAtTime(0.0003, end + r);
  if (p.trem) {
    const l = ctx.createOscillator();
    l.type = 'sine';
    l.frequency.value = p.trem[0];
    const lg = ctx.createGain();
    lg.gain.value = peak * p.trem[1];
    l.connect(lg); lg.connect(g.gain);
    l.start(t); l.stop(end + r + 0.05);
    if (o.srcs) o.srcs.push(l);
  }
  return g;
}

/** Drives an AudioParam with a sine LFO. Returns the LFO oscillator. */
function modParam(ctx, o, param, t, rate, depth, hold) {
  const l = ctx.createOscillator();
  l.type = 'sine';
  l.frequency.value = Math.max(0.01, rate);
  const g = ctx.createGain();
  g.gain.value = depth;
  l.connect(g); g.connect(param);
  l.start(t);
  if (!hold) l.stop(t + 30);
  if (o.srcs) o.srcs.push(l);
  return l;
}

/**
 * One oscillator voice. Returns the absolute end time so callers can report a
 * sound's real duration back to the engine.
 * p: { type, f, f2, sweep, lin, dur, at, gain, a, d, s, r, lp, hp, bp, q,
 *      vib:[rateHz, cents], trem:[rateHz, depth], detune, hold, fixed }
 */
function tone(ctx, dest, o, p) {
  const t = o.t + (p.at || 0);
  const pitch = p.fixed ? 1 : (o.pitch || 1);
  const dur = Math.max(0.005, p.dur == null ? 0.2 : p.dur);
  const rel = p.hold ? 0 : Math.max(0.005, p.r == null ? 0.05 : p.r);
  const osc = ctx.createOscillator();
  osc.type = p.type || 'sine';
  osc.frequency.setValueAtTime(clamp((p.f == null ? 220 : p.f) * pitch, 1, 20000), t);
  if (p.f2 != null) {
    const te = t + dur * (p.sweep == null ? 1 : p.sweep);
    const f1 = clamp(p.f2 * pitch, 1, 20000);
    if (p.lin) osc.frequency.linearRampToValueAtTime(f1, te);
    else osc.frequency.exponentialRampToValueAtTime(f1, te);
  }
  if (p.detune) osc.detune.setValueAtTime(p.detune, t);
  if (p.vib) modParam(ctx, o, osc.detune, t, p.vib[0], p.vib[1], p.hold);
  let head = osc;
  if (p.bp) head = pipe(head, biquad(ctx, 'bandpass', p.bp[0], p.q, t, dur, p.bp[1]));
  if (p.lp) head = pipe(head, biquad(ctx, 'lowpass', p.lp[0], p.q, t, dur, p.lp[1]));
  if (p.hp) head = pipe(head, biquad(ctx, 'highpass', p.hp[0], p.hq == null ? 0.7 : p.hq, t, dur, p.hp[1]));
  const g = envGain(ctx, o, t, dur, p);
  head.connect(g);
  g.connect(dest);
  osc.start(t);
  if (!p.hold) osc.stop(t + dur + rel + 0.05);
  if (o.srcs) o.srcs.push(osc);
  return t + dur + rel;
}

/** One filtered noise burst. Same parameter shape as tone(), plus `color`/`rate`. */
function noise(ctx, dest, o, p) {
  const t = o.t + (p.at || 0);
  const dur = Math.max(0.005, p.dur == null ? 0.15 : p.dur);
  const rel = p.hold ? 0 : Math.max(0.005, p.r == null ? 0.04 : p.r);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, p.color || 'white');
  src.loop = true;
  src.playbackRate.value = clamp((p.rate == null ? 1 : p.rate) * (p.fixed ? 1 : (o.pitch || 1)), 0.06, 8);
  let head = src;
  if (p.bp) head = pipe(head, biquad(ctx, 'bandpass', p.bp[0], p.q == null ? 3 : p.q, t, dur, p.bp[1]));
  if (p.lp) head = pipe(head, biquad(ctx, 'lowpass', p.lp[0], p.q, t, dur, p.lp[1]));
  if (p.hp) head = pipe(head, biquad(ctx, 'highpass', p.hp[0], p.hq == null ? 0.7 : p.hq, t, dur, p.hp[1]));
  const g = envGain(ctx, o, t, dur, p);
  head.connect(g);
  g.connect(dest);
  const off = (o.rng ? o.rng.next() : Math.random()) * (NOISE_SECONDS - 0.2);
  src.start(t, off);
  if (!p.hold) src.stop(t + dur + rel + 0.05);
  if (o.srcs) o.srcs.push(src);
  return t + dur + rel;
}

/** Two-operator FM voice - bells, chimes, metal, note blocks. */
function bell(ctx, dest, o, p) {
  const t = o.t + (p.at || 0);
  const dur = Math.max(0.02, p.dur == null ? 1.2 : p.dur);
  const rel = Math.max(0.01, p.r == null ? 0.06 : p.r);
  const pitch = p.fixed ? 1 : (o.pitch || 1);
  const f = clamp((p.f == null ? 440 : p.f) * pitch, 1, 18000);
  const car = ctx.createOscillator();
  car.type = p.type || 'sine';
  car.frequency.setValueAtTime(f, t);
  if (p.f2 != null) car.frequency.exponentialRampToValueAtTime(clamp(p.f2 * pitch, 1, 18000), t + dur);
  const mod = ctx.createOscillator();
  mod.type = p.modType || 'sine';
  mod.frequency.setValueAtTime(f * (p.ratio == null ? 2 : p.ratio), t);
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * (p.index == null ? 3 : p.index), t);
  mg.gain.exponentialRampToValueAtTime(Math.max(0.01, f * 0.02), t + dur * 0.6);
  mod.connect(mg); mg.connect(car.frequency);
  const peak = p.gain == null ? 0.25 : p.gain;
  let head = car;
  if (p.lp) head = pipe(head, biquad(ctx, 'lowpass', p.lp[0], p.q, t, dur, p.lp[1]));
  const g = envGain(ctx, o, t, dur, {
    gain: peak, a: p.a == null ? 0.003 : p.a, d: p.d == null ? dur * 0.92 : p.d,
    s: peak * 0.0015, r: rel, trem: p.trem,
  });
  head.connect(g); g.connect(dest);
  car.start(t); mod.start(t);
  car.stop(t + dur + rel + 0.05);
  mod.stop(t + dur + rel + 0.05);
  if (o.srcs) o.srcs.push(car, mod);
  return t + dur + rel;
}

/** Inserts a soft-clip stage in front of `dest` and returns the new input node. */
function grit(ctx, dest, amount, mix) {
  const ws = ctx.createWaveShaper();
  ws.curve = distCurve(ctx, amount);
  const g = ctx.createGain();
  g.gain.value = mix == null ? 0.8 : mix;
  ws.connect(g); g.connect(dest);
  return ws;
}

/** Inserts a resonant formant peak in front of `dest`. */
function formant(ctx, dest, f, q, db) {
  const pk = ctx.createBiquadFilter();
  pk.type = 'peaking';
  pk.frequency.value = clamp(f, 40, 12000);
  pk.Q.value = q == null ? 3 : q;
  pk.gain.value = db == null ? 10 : db;
  pk.connect(dest);
  return pk;
}

// ---------------------------------------------------------------------------
// Block material sounds - step / dig / place / break for every `sound` field
// value a block definition can carry.
// ---------------------------------------------------------------------------

const MATERIALS = {
  stone:       { color: 'white', lp: [2400, 700],  hp: 200,  f: 120, gain: 0.30, dig: 0.40, q: 1.0, grains: 2 },
  deepslate:   { color: 'white', lp: [2100, 560],  hp: 180,  f: 100, gain: 0.30, dig: 0.40, q: 1.1, grains: 2 },
  netherrack:  { color: 'pink',  lp: [1700, 520],  hp: 150,  f: 132, gain: 0.30, dig: 0.38, q: 0.9, grains: 3 },
  wood:        { color: 'pink',  lp: [1500, 420],  hp: 120,  f: 172, gain: 0.32, dig: 0.40, q: 1.7, res: 1 },
  bamboo:      { color: 'pink',  lp: [2600, 900],  hp: 300,  f: 430, gain: 0.26, dig: 0.32, q: 3.2, res: 1 },
  grass:       { color: 'white', lp: [3800, 1400], hp: 700,  f: 0,   gain: 0.22, dig: 0.28, q: 0.7 },
  plant:       { color: 'white', lp: [4400, 1800], hp: 950,  f: 0,   gain: 0.17, dig: 0.24, q: 0.7 },
  moss:        { color: 'pink',  lp: [2200, 800],  hp: 340,  f: 0,   gain: 0.20, dig: 0.26, q: 0.7 },
  gravel:      { color: 'white', lp: [3000, 900],  hp: 280,  f: 92,  gain: 0.28, dig: 0.36, q: 0.8, grains: 5 },
  sand:        { color: 'white', lp: [5200, 2200], hp: 1200, f: 0,   gain: 0.24, dig: 0.30, q: 0.6, grains: 3 },
  soul_sand:   { color: 'brown', lp: [1200, 380],  hp: 120,  f: 70,  gain: 0.26, dig: 0.32, q: 0.7, squelch: 0.6 },
  glass:       { color: 'white', lp: [9000, 4000], hp: 2200, f: 0,   gain: 0.24, dig: 0.38, q: 1.0, shards: 5 },
  amethyst:    { color: 'white', lp: [7000, 3000], hp: 1600, f: 1180, gain: 0.22, dig: 0.32, q: 5, chime: 3 },
  wool:        { color: 'brown', lp: [900, 260],   hp: 60,   f: 0,   gain: 0.22, dig: 0.26, q: 0.6 },
  metal:       { color: 'white', lp: [6000, 2200], hp: 600,  f: 520, gain: 0.26, dig: 0.34, q: 7, ring: 1 },
  copper:      { color: 'white', lp: [5200, 1900], hp: 500,  f: 434, gain: 0.26, dig: 0.32, q: 6, ring: 0.8 },
  snow:        { color: 'white', lp: [6000, 2600], hp: 1500, f: 0,   gain: 0.20, dig: 0.24, q: 0.6 },
  slime:       { color: 'brown', lp: [1400, 300],  hp: 80,   f: 180, gain: 0.30, dig: 0.34, q: 2, squelch: 1 },
  honey:       { color: 'brown', lp: [1100, 240],  hp: 70,   f: 152, gain: 0.28, dig: 0.32, q: 2, squelch: 1.1 },
  ladder:      { color: 'pink',  lp: [2000, 600],  hp: 200,  f: 262, gain: 0.26, dig: 0.30, q: 2.2, res: 1 },
  anvil:       { color: 'white', lp: [7000, 2600], hp: 500,  f: 330, gain: 0.34, dig: 0.46, q: 11, ring: 1.6 },
  nether_wart: { color: 'pink',  lp: [2600, 1000], hp: 400,  f: 0,   gain: 0.20, dig: 0.24, q: 0.8 },
  sculk:       { color: 'brown', lp: [1300, 320],  hp: 90,   f: 88,  gain: 0.26, dig: 0.30, q: 1.4, squelch: 0.8 },
};

function matStep(m) {
  return (ctx, dest, o) => {
    const dur = 0.05 + o.rng.next() * 0.03;
    let e = noise(ctx, dest, o, {
      color: m.color, dur, r: 0.03, gain: m.gain * 0.8, a: 0.002, d: dur * 0.6, s: m.gain * 0.04,
      lp: [m.lp[0] * 0.8, m.lp[1]], hp: [m.hp], q: m.q, rate: 0.8 + o.rng.next() * 0.45,
    });
    if (m.f) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'sine', f: m.f * 0.9, f2: m.f * 0.55, dur: 0.06,
        gain: m.gain * 0.32, a: 0.002, d: 0.05, s: 0.0003, r: 0.03,
      }));
    }
    if (m.ring) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'triangle', f: m.f * 2, dur: 0.1, gain: m.gain * 0.11 * m.ring,
        a: 0.001, d: 0.09, s: 0.0003, r: 0.05,
      }));
    }
    return e;
  };
}

function matDig(m) {
  return (ctx, dest, o) => {
    const rng = o.rng;
    const dur = 0.15 + rng.next() * 0.09;
    let e = noise(ctx, dest, o, {
      color: m.color, dur, r: 0.06, gain: m.dig, a: 0.003, d: dur * 0.7, s: m.dig * 0.07,
      lp: [m.lp[0], m.lp[1] * 0.7], hp: [m.hp], q: m.q, rate: 0.9 + rng.next() * 0.35,
    });
    const grains = m.grains || 2;
    for (let i = 0; i < grains; i++) {
      e = Math.max(e, noise(ctx, dest, o, {
        color: m.color, at: 0.015 + i * 0.032 + rng.next() * 0.02, dur: 0.038, r: 0.02,
        gain: m.dig * (0.28 + rng.next() * 0.3), a: 0.001, d: 0.03, s: 0.0003,
        bp: [m.lp[0] * (0.45 + rng.next() * 0.8)], q: 2.5,
      }));
    }
    if (m.f) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'sine', f: m.f, f2: m.f * 0.5, dur: 0.13, gain: m.dig * 0.34,
        a: 0.002, d: 0.11, s: 0.0003, r: 0.05,
      }));
    }
    if (m.res) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'triangle', f: m.f * 1.5, f2: m.f * 1.2, dur: 0.16, gain: m.dig * 0.2,
        a: 0.002, d: 0.14, s: 0.0003, r: 0.06, lp: [m.lp[0]], q: m.q,
      }));
    }
    if (m.shards) {
      for (let i = 0; i < m.shards; i++) {
        e = Math.max(e, tone(ctx, dest, o, {
          type: 'triangle', at: 0.02 + i * 0.042 + rng.next() * 0.02,
          f: 2100 + rng.next() * 3800, f2: 1300, dur: 0.09, gain: 0.10,
          a: 0.001, d: 0.08, s: 0.0003, r: 0.04,
        }));
      }
    }
    if (m.ring) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'triangle', f: m.f * 2.4, dur: 0.36 * m.ring, gain: m.dig * 0.2,
        a: 0.001, d: 0.32, s: 0.0003, r: 0.09,
      }));
    }
    if (m.chime) {
      for (let i = 0; i < m.chime; i++) {
        e = Math.max(e, bell(ctx, dest, o, {
          at: i * 0.05, f: m.f * (1 + i * 0.55), dur: 0.55, ratio: 3.1, index: 2, gain: 0.11,
        }));
      }
    }
    if (m.squelch) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'sawtooth', f: (m.f || 160) * 1.4, f2: (m.f || 160) * 0.4, dur: 0.19,
        gain: m.dig * 0.42 * m.squelch, a: 0.006, d: 0.17, s: 0.0003, r: 0.05,
        lp: [900, 240], q: 6,
      }));
    }
    return e;
  };
}

function matPlace(m) {
  return (ctx, dest, o) => {
    const dur = 0.085 + o.rng.next() * 0.04;
    let e = noise(ctx, dest, o, {
      color: m.color, dur, r: 0.04, gain: m.gain * 1.05, a: 0.002, d: dur * 0.55, s: m.gain * 0.05,
      lp: [m.lp[0] * 0.9, m.lp[1] * 0.8], hp: [m.hp * 0.8], q: m.q, rate: 0.75 + o.rng.next() * 0.35,
    });
    e = Math.max(e, tone(ctx, dest, o, {
      type: 'sine', f: (m.f || 150) * 0.85, f2: (m.f || 150) * 0.45, dur: 0.1,
      gain: m.gain * 0.4, a: 0.002, d: 0.09, s: 0.0003, r: 0.04,
    }));
    if (m.ring) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'triangle', f: m.f * 1.9, dur: 0.2, gain: m.gain * 0.14 * m.ring,
        a: 0.001, d: 0.18, s: 0.0003, r: 0.06,
      }));
    }
    if (m.shards) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'triangle', f: 3200, f2: 2400, dur: 0.11, gain: 0.09, a: 0.001, d: 0.1, s: 0.0003, r: 0.04,
      }));
    }
    if (m.squelch) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'sawtooth', f: (m.f || 160) * 0.9, f2: (m.f || 160) * 1.5, dur: 0.14,
        gain: m.gain * 0.4, a: 0.006, d: 0.12, s: 0.0003, r: 0.05, lp: [800, 300], q: 5,
      }));
    }
    return e;
  };
}

for (const matName of Object.keys(MATERIALS)) {
  const m = MATERIALS[matName];
  S('step_' + matName, 'blocks', 0.34, 0.16, matStep(m), { cooldown: 0.05, maxDist: 16 });
  S('dig_' + matName, 'blocks', 0.85, 0.14, matDig(m), { cooldown: 0.02 });
  S('place_' + matName, 'blocks', 0.9, 0.12, matPlace(m));
  alias('break_' + matName, 'dig_' + matName);
  alias('hit_' + matName, 'step_' + matName);
}

// Generic + synonym material names other modules may reach for.
alias('step', 'step_stone');
alias('dig', 'dig_stone');
alias('place', 'place_stone');
alias('break', 'dig_stone');
alias('hit', 'step_stone');
for (const [from, to] of [
  ['cloth', 'wool'], ['stem', 'wood'], ['fungus', 'wood'], ['nether_wood', 'wood'],
  ['hyphae', 'wood'], ['scaffolding', 'bamboo'], ['candle', 'wool'], ['crop', 'plant'],
  ['vine', 'plant'], ['lily_pad', 'plant'], ['coral', 'stone'], ['nether_bricks', 'stone'],
  ['basalt', 'stone'], ['calcite', 'stone'], ['tuff', 'stone'], ['dripstone', 'stone'],
  ['powder_snow', 'snow'], ['chain', 'metal'], ['lantern', 'metal'], ['netherite', 'metal'],
  ['bone', 'stone'], ['shroomlight', 'wool'], ['soul_soil', 'soul_sand'], ['mud', 'soul_sand'],
  ['packed_mud', 'gravel'], ['froglight', 'glass'], ['azalea', 'plant'], ['cave_vines', 'plant'],
  ['big_dripleaf', 'plant'], ['rooted_dirt', 'gravel'], ['dirt', 'gravel'], ['nylium', 'grass'],
]) {
  alias('step_' + from, 'step_' + to);
  alias('dig_' + from, 'dig_' + to);
  alias('place_' + from, 'place_' + to);
  alias('break_' + from, 'dig_' + to);
  alias('hit_' + from, 'step_' + to);
}

// ---------------------------------------------------------------------------
// Player, UI, tools and world sounds
// ---------------------------------------------------------------------------

S('generic_hurt', 'players', 0.85, 0.12, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 300, f2: 175, dur: 0.2, gain: 0.30, a: 0.004, d: 0.16, s: 0.02, r: 0.07, lp: [1700, 620], q: 1.4 });
  e = Math.max(e, tone(ctx, dest, o, { type: 'square', f: 150, f2: 92, dur: 0.18, gain: 0.11, a: 0.004, d: 0.14, s: 0.008, r: 0.06, lp: [900, 400] }));
  return Math.max(e, noise(ctx, dest, o, { color: 'pink', dur: 0.09, gain: 0.07, a: 0.003, d: 0.07, s: 0.001, bp: [950], q: 1.3 }));
});
alias('hurt', 'generic_hurt');
alias('player_hurt', 'generic_hurt');

S('generic_death', 'players', 0.95, 0.06, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 280, f2: 90, dur: 0.65, gain: 0.30, a: 0.008, d: 0.5, s: 0.03, r: 0.16, lp: [1500, 380], q: 1.6, vib: [6, 30] });
  e = Math.max(e, tone(ctx, dest, o, { type: 'square', f: 140, f2: 48, dur: 0.7, gain: 0.10, a: 0.01, d: 0.55, s: 0.01, r: 0.16, lp: [700, 240] }));
  return Math.max(e, noise(ctx, dest, o, { color: 'pink', dur: 0.4, gain: 0.06, a: 0.01, d: 0.35, s: 0.002, bp: [700, 300], q: 1.2 }));
});
alias('death', 'generic_death');
alias('player_death', 'generic_death');

S('generic_idle', 'neutral', 0.5, 0.14, (ctx, dest, o) =>
  tone(ctx, dest, o, { type: 'sawtooth', f: 210, f2: 180, dur: 0.35, gain: 0.18, a: 0.03, d: 0.25, s: 0.04, r: 0.12, lp: [1200, 600], q: 1.5, vib: [5, 18] }));

S('eat', 'players', 0.7, 0.2, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 2; i++) {
    e = Math.max(e, noise(ctx, dest, o, { color: 'brown', at: i * 0.11, dur: 0.075, gain: 0.26, a: 0.004, d: 0.06, s: 0.001, lp: [1400, 500], hp: [180], q: 1.4, rate: 0.9 + o.rng.next() * 0.3 }));
    e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.11, f: 190, f2: 110, dur: 0.08, gain: 0.13, a: 0.004, d: 0.07, s: 0.0005, r: 0.03 }));
  }
  return e;
}, { cooldown: 0.08 });

S('drink', 'players', 0.7, 0.16, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 3; i++) {
    e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.1, f: 300 + o.rng.next() * 140, f2: 150, dur: 0.075, gain: 0.2, a: 0.006, d: 0.06, s: 0.0005, r: 0.03, lp: [1200] }));
    e = Math.max(e, noise(ctx, dest, o, { color: 'brown', at: i * 0.1, dur: 0.05, gain: 0.09, a: 0.004, d: 0.04, s: 0.0005, lp: [900], hp: [140] }));
  }
  return e;
}, { cooldown: 0.08 });

S('burp', 'players', 0.75, 0.12, (ctx, dest, o) => {
  const g = grit(ctx, dest, 22, 0.85);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 120, f2: 70, dur: 0.34, gain: 0.30, a: 0.01, d: 0.26, s: 0.05, r: 0.09, lp: [800, 300], q: 3, trem: [26, 0.5] });
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 0.3, gain: 0.1, a: 0.01, d: 0.24, s: 0.008, lp: [600, 260], q: 2 }));
});

S('level_up', 'players', 0.9, 0, (ctx, dest, o) => {
  let e = o.t;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < notes.length; i++) {
    e = Math.max(e, bell(ctx, dest, o, { at: i * 0.075, f: notes[i], dur: 1.1 - i * 0.1, ratio: 2, index: 1.4, gain: 0.20 }));
  }
  return e;
}, { reverb: 0.3 });

S('xp_pickup', 'players', 0.45, 0.3, (ctx, dest, o) =>
  bell(ctx, dest, o, { f: 1180, f2: 1560, dur: 0.16, ratio: 3.2, index: 1.6, gain: 0.2, a: 0.002 }), { cooldown: 0.03 });
alias('xp', 'xp_pickup');
alias('experience_orb_pickup', 'xp_pickup');
alias('orb_pickup', 'xp_pickup');

S('item_pickup', 'players', 0.5, 0.25, (ctx, dest, o) => {
  const e = tone(ctx, dest, o, { type: 'sine', f: 520, f2: 980, dur: 0.07, gain: 0.24, a: 0.002, d: 0.06, s: 0.0005, r: 0.03 });
  return Math.max(e, noise(ctx, dest, o, { color: 'white', dur: 0.03, gain: 0.05, a: 0.001, d: 0.025, s: 0.0003, hp: [2400] }));
}, { cooldown: 0.03 });
alias('pop', 'item_pickup');
alias('pickup', 'item_pickup');

S('item_drop', 'players', 0.4, 0.2, (ctx, dest, o) =>
  tone(ctx, dest, o, { type: 'sine', f: 620, f2: 300, dur: 0.08, gain: 0.2, a: 0.002, d: 0.07, s: 0.0005, r: 0.03 }));
alias('throw', 'item_drop');

S('craft', 'players', 0.7, 0.1, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 3; i++) {
    e = Math.max(e, noise(ctx, dest, o, { color: 'pink', at: i * 0.045, dur: 0.05, gain: 0.2, a: 0.002, d: 0.04, s: 0.0004, bp: [900 + o.rng.next() * 900], q: 3 }));
    e = Math.max(e, tone(ctx, dest, o, { type: 'triangle', at: i * 0.045, f: 260 + i * 90, dur: 0.06, gain: 0.11, a: 0.002, d: 0.05, s: 0.0004, r: 0.03 }));
  }
  return e;
});

S('click', 'players', 0.4, 0.06, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.018, gain: 0.24, a: 0.001, d: 0.015, s: 0.0003, bp: [2600], q: 2.5 });
  return Math.max(e, tone(ctx, dest, o, { type: 'square', f: 900, f2: 520, dur: 0.03, gain: 0.09, a: 0.001, d: 0.025, s: 0.0003, r: 0.02 }));
}, { cooldown: 0.01 });
alias('ui_click', 'click');
alias('menu_click', 'click');
alias('button_click', 'click');

S('lever', 'blocks', 0.6, 0.15, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.03, gain: 0.28, a: 0.001, d: 0.024, s: 0.0003, bp: [1800, 900], q: 4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'square', f: 700, f2: 380, dur: 0.05, gain: 0.12, a: 0.001, d: 0.045, s: 0.0003, r: 0.02 }));
});
S('button', 'blocks', 0.55, 0.15, (ctx, dest, o) =>
  tone(ctx, dest, o, { type: 'square', f: 620, f2: 420, dur: 0.045, gain: 0.2, a: 0.001, d: 0.04, s: 0.0003, r: 0.02, lp: [3000] }));
alias('button_wood', 'button');
alias('button_stone', 'lever');
alias('pressure_plate', 'button');
alias('tripwire', 'click');

S('door_open', 'blocks', 0.75, 0.1, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 260, f2: 400, dur: 0.42, gain: 0.14, a: 0.02, d: 0.3, s: 0.04, r: 0.09, lp: [1500, 900], q: 6, vib: [17, 40] });
  e = Math.max(e, noise(ctx, dest, o, { color: 'pink', dur: 0.4, gain: 0.08, a: 0.02, d: 0.3, s: 0.01, bp: [1100, 1700], q: 5 }));
  return Math.max(e, noise(ctx, dest, o, { color: 'pink', at: 0.4, dur: 0.06, gain: 0.16, a: 0.002, d: 0.05, s: 0.0004, lp: [900], hp: [130] }));
});
S('door_close', 'blocks', 0.75, 0.1, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 380, f2: 240, dur: 0.3, gain: 0.12, a: 0.02, d: 0.22, s: 0.03, r: 0.07, lp: [1400, 800], q: 6, vib: [15, 35] });
  e = Math.max(e, noise(ctx, dest, o, { color: 'pink', at: 0.3, dur: 0.09, gain: 0.26, a: 0.002, d: 0.08, s: 0.0005, lp: [1100, 400], hp: [110] }));
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', at: 0.3, f: 150, f2: 80, dur: 0.12, gain: 0.16, a: 0.002, d: 0.1, s: 0.0004, r: 0.05 }));
});
S('iron_door_open', 'blocks', 0.75, 0.08, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 520, f2: 700, dur: 0.35, gain: 0.11, a: 0.02, d: 0.26, s: 0.03, r: 0.08, bp: [1800, 2600], q: 9 });
  return Math.max(e, noise(ctx, dest, o, { color: 'white', at: 0.34, dur: 0.08, gain: 0.16, a: 0.002, d: 0.07, s: 0.0004, bp: [1600], q: 3 }));
});
S('iron_door_close', 'blocks', 0.75, 0.08, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 700, f2: 480, dur: 0.28, gain: 0.1, a: 0.02, d: 0.2, s: 0.02, r: 0.07, bp: [2200, 1500], q: 9 });
  e = Math.max(e, noise(ctx, dest, o, { color: 'white', at: 0.28, dur: 0.1, gain: 0.2, a: 0.002, d: 0.09, s: 0.0004, bp: [1400, 700], q: 2.5 }));
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', at: 0.28, f: 420, dur: 0.28, gain: 0.09, a: 0.001, d: 0.26, s: 0.0004, r: 0.07 }));
});
alias('trapdoor_open', 'door_open');
alias('trapdoor_close', 'door_close');
alias('fence_gate_open', 'door_open');
alias('fence_gate_close', 'door_close');
alias('iron_trapdoor_open', 'iron_door_open');
alias('iron_trapdoor_close', 'iron_door_close');

S('chest_open', 'blocks', 0.7, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'pink', dur: 0.3, gain: 0.18, a: 0.015, d: 0.24, s: 0.02, bp: [700, 1500], q: 3, rate: 0.9 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 200, f2: 330, dur: 0.3, gain: 0.1, a: 0.02, d: 0.24, s: 0.02, r: 0.08, lp: [1100, 1600], q: 4 }));
});
S('chest_close', 'blocks', 0.7, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'pink', dur: 0.2, gain: 0.16, a: 0.012, d: 0.16, s: 0.015, bp: [1200, 600], q: 3 });
  e = Math.max(e, noise(ctx, dest, o, { color: 'pink', at: 0.2, dur: 0.08, gain: 0.24, a: 0.002, d: 0.07, s: 0.0005, lp: [1000, 380], hp: [120] }));
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', at: 0.2, f: 165, f2: 85, dur: 0.11, gain: 0.15, a: 0.002, d: 0.1, s: 0.0004, r: 0.04 }));
});
alias('barrel_open', 'chest_open');
alias('barrel_close', 'chest_close');
alias('shulker_box_open', 'chest_open');
alias('shulker_box_close', 'chest_close');

S('ender_chest_open', 'blocks', 0.7, 0.08, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 4; i++) {
    e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.05, f: 220 * (1 + i * 0.37), f2: 320 * (1 + i * 0.37), dur: 0.5, gain: 0.10, a: 0.03, d: 0.4, s: 0.01, r: 0.15, vib: [7, 30] }));
  }
  return Math.max(e, noise(ctx, dest, o, { color: 'sparkle', dur: 0.5, gain: 0.07, a: 0.05, d: 0.4, s: 0.005, bp: [1800, 3400], q: 2 }));
}, { reverb: 0.4 });
alias('ender_chest_close', 'ender_chest_open');

S('fizz', 'blocks', 0.7, 0.15, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.42, gain: 0.26, a: 0.004, d: 0.36, s: 0.02, bp: [3200, 900], q: 1.1 });
  return Math.max(e, noise(ctx, dest, o, { color: 'pink', dur: 0.3, gain: 0.12, a: 0.004, d: 0.26, s: 0.01, lp: [1400, 400] }));
});
alias('extinguish', 'fizz');
alias('lava_extinguish', 'fizz');
alias('water_evaporate', 'fizz');

S('flint_and_steel', 'blocks', 0.7, 0.16, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.09, gain: 0.3, a: 0.001, d: 0.08, s: 0.001, bp: [4200, 2200], q: 2 });
  return Math.max(e, noise(ctx, dest, o, { color: 'crackle', at: 0.05, dur: 0.25, gain: 0.12, a: 0.005, d: 0.2, s: 0.01, bp: [2600], q: 1.5 }));
});
alias('ignite', 'flint_and_steel');

S('fire', 'ambient', 0.5, 0, (ctx, dest, o) => {
  noise(ctx, dest, o, { color: 'crackle', dur: 1, gain: 0.24, a: 0.5, hold: true, lp: [2600], hp: [200], q: 1 });
  noise(ctx, dest, o, { color: 'brown', dur: 1, gain: 0.09, a: 0.8, hold: true, lp: [420], q: 1 });
  return Infinity;
}, { loop: true, maxDist: 12 });
alias('fire_crackle', 'fire');
alias('campfire_crackle', 'fire');

S('explode', 'blocks', 1.0, 0.15, (ctx, dest, o) => {
  const g = grit(ctx, dest, 14, 0.9);
  let e = noise(ctx, g, o, { color: 'brown', dur: 1.05, gain: 0.55, a: 0.004, d: 0.75, s: 0.03, r: 0.35, lp: [2200, 150], q: 0.9, rate: 1 });
  e = Math.max(e, noise(ctx, g, o, { color: 'white', dur: 0.24, gain: 0.32, a: 0.002, d: 0.2, s: 0.004, hp: [700], lp: [9000, 2000] }));
  e = Math.max(e, tone(ctx, g, o, { type: 'sine', f: 88, f2: 26, dur: 0.75, gain: 0.45, a: 0.004, d: 0.6, s: 0.01, r: 0.3 }));
  e = Math.max(e, tone(ctx, g, o, { type: 'triangle', f: 150, f2: 40, dur: 0.5, gain: 0.18, a: 0.004, d: 0.42, s: 0.005, r: 0.2 }));
  return Math.max(e, noise(ctx, dest, o, { color: 'crackle', at: 0.1, dur: 1.2, gain: 0.13, a: 0.05, d: 0.9, s: 0.01, r: 0.3, lp: [1800, 500] }));
}, { maxDist: 64, reverb: 0.35 });
alias('explosion', 'explode');
alias('generic_explode', 'explode');

S('tnt_prime', 'blocks', 0.8, 0.05, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.35, gain: 0.16, a: 0.004, d: 0.3, s: 0.03, bp: [5200, 3800], q: 1.6 });
  return Math.max(e, tone(ctx, dest, o, { type: 'square', f: 880, f2: 660, dur: 0.09, gain: 0.09, a: 0.002, d: 0.08, s: 0.0005, r: 0.03 }));
}, { maxDist: 24 });
alias('fuse', 'tnt_prime');

S('bow', 'players', 0.7, 0.15, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.075, gain: 0.24, a: 0.001, d: 0.06, s: 0.001, bp: [1400, 600], q: 2.2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 420, f2: 170, dur: 0.11, gain: 0.16, a: 0.002, d: 0.09, s: 0.0005, r: 0.04 }));
});
alias('bow_shoot', 'bow');
alias('arrow_shoot', 'bow');
S('crossbow_load', 'players', 0.6, 0.1, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 5; i++) e = Math.max(e, noise(ctx, dest, o, { color: 'white', at: i * 0.085, dur: 0.03, gain: 0.16, a: 0.001, d: 0.025, s: 0.0003, bp: [1500 + i * 260], q: 6 }));
  return e;
});
S('crossbow_shoot', 'players', 0.75, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.08, gain: 0.3, a: 0.001, d: 0.06, s: 0.001, bp: [1900, 800], q: 2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'square', f: 520, f2: 180, dur: 0.1, gain: 0.13, a: 0.001, d: 0.09, s: 0.0004, r: 0.04 }));
});

S('arrow_hit', 'players', 0.6, 0.18, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'pink', dur: 0.06, gain: 0.28, a: 0.001, d: 0.05, s: 0.0005, bp: [1100, 500], q: 2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 300, f2: 140, dur: 0.08, gain: 0.15, a: 0.001, d: 0.07, s: 0.0004, r: 0.03 }));
});
S('arrow_hit_player', 'players', 0.6, 0.1, (ctx, dest, o) =>
  bell(ctx, dest, o, { f: 1500, dur: 0.24, ratio: 2.4, index: 2, gain: 0.2 }));
S('arrow_whoosh', 'players', 0.5, 0.2, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.22, gain: 0.16, a: 0.05, d: 0.14, s: 0.01, bp: [900, 2600], q: 1.4 }));
alias('whoosh', 'arrow_whoosh');
alias('swoosh', 'arrow_whoosh');

S('shield_block', 'players', 0.75, 0.14, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'pink', dur: 0.11, gain: 0.32, a: 0.001, d: 0.09, s: 0.001, lp: [1600, 500], hp: [140], q: 1.4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 210, f2: 130, dur: 0.16, gain: 0.18, a: 0.002, d: 0.14, s: 0.0005, r: 0.05 }));
});
S('shield_break', 'players', 0.85, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'pink', dur: 0.3, gain: 0.32, a: 0.002, d: 0.24, s: 0.004, lp: [2200, 400], q: 1.2 });
  for (let i = 0; i < 4; i++) e = Math.max(e, tone(ctx, dest, o, { type: 'triangle', at: 0.02 + i * 0.05, f: 400 + o.rng.next() * 700, f2: 200, dur: 0.14, gain: 0.1, a: 0.001, d: 0.12, s: 0.0004, r: 0.05 }));
  return e;
});

S('trident_throw', 'players', 0.8, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.3, gain: 0.2, a: 0.02, d: 0.24, s: 0.01, bp: [700, 2800], q: 1.6 });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 320, f2: 900, dur: 0.28, gain: 0.14, a: 0.01, d: 0.24, s: 0.006, r: 0.07 }));
});
S('trident_return', 'players', 0.8, 0.1, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'triangle', f: 900, f2: 260, dur: 0.34, gain: 0.16, a: 0.02, d: 0.28, s: 0.008, r: 0.08 });
  return Math.max(e, noise(ctx, dest, o, { color: 'white', dur: 0.34, gain: 0.16, a: 0.02, d: 0.28, s: 0.008, bp: [2600, 600], q: 1.6 }));
});
S('trident_riptide', 'players', 0.9, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'brown', dur: 0.7, gain: 0.34, a: 0.05, d: 0.5, s: 0.05, r: 0.15, lp: [500, 2600], q: 1.2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 120, f2: 560, dur: 0.65, gain: 0.14, a: 0.05, d: 0.5, s: 0.02, r: 0.14, lp: [900, 2400], q: 3 }));
});
S('trident_thunder', 'weather', 1.0, 0.08, (ctx, dest, o) => {
  const g = grit(ctx, dest, 10, 0.9);
  let e = noise(ctx, g, o, { color: 'brown', dur: 1.2, gain: 0.5, a: 0.004, d: 0.9, s: 0.03, r: 0.4, lp: [3000, 180] });
  return Math.max(e, tone(ctx, g, o, { type: 'sine', f: 70, f2: 24, dur: 0.9, gain: 0.35, a: 0.003, d: 0.7, s: 0.008, r: 0.35 }));
}, { maxDist: 96 });

S('splash', 'players', 0.75, 0.2, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.28, gain: 0.34, a: 0.003, d: 0.22, s: 0.01, bp: [1800, 5200], q: 0.9 });
  e = Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.2, gain: 0.16, a: 0.003, d: 0.16, s: 0.005, lp: [900, 300] }));
  for (let i = 0; i < 3; i++) e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: 0.03 + i * 0.05, f: 700 + o.rng.next() * 900, f2: 1800, dur: 0.06, gain: 0.07, a: 0.002, d: 0.05, s: 0.0003, r: 0.03 }));
  return e;
});
alias('splash_high', 'splash');
alias('water_splash', 'splash');
alias('entity_splash', 'splash');

S('swim', 'players', 0.5, 0.24, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.24, gain: 0.2, a: 0.04, d: 0.16, s: 0.01, bp: [900, 2400], q: 1.1, rate: 0.8 + o.rng.next() * 0.5 }), { cooldown: 0.08 });
alias('swim_stroke', 'swim');

S('bubble', 'ambient', 0.45, 0.3, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 3; i++) {
    e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.06 + o.rng.next() * 0.03, f: 420 + o.rng.next() * 500, f2: 1400 + o.rng.next() * 900, dur: 0.075, gain: 0.14, a: 0.003, d: 0.065, s: 0.0004, r: 0.03, lp: [3000] }));
  }
  return e;
});
alias('bubble_pop', 'bubble');
alias('underwater_ambient', 'bubble');

S('water', 'ambient', 0.4, 0, (ctx, dest, o) => {
  noise(ctx, dest, o, { color: 'white', dur: 1, gain: 0.16, a: 0.7, hold: true, bp: [1400, 0], q: 0.8, lp: [3800] });
  noise(ctx, dest, o, { color: 'sparkle', dur: 1, gain: 0.09, a: 0.9, hold: true, bp: [2600], q: 1.4 });
  return Infinity;
}, { loop: true, maxDist: 14 });
alias('water_flow', 'water');
alias('water_ambient', 'water');

S('lava', 'ambient', 0.42, 0, (ctx, dest, o) => {
  noise(ctx, dest, o, { color: 'brown', dur: 1, gain: 0.22, a: 0.9, hold: true, lp: [320] });
  noise(ctx, dest, o, { color: 'crackle', dur: 1, gain: 0.1, a: 1.2, hold: true, lp: [900], rate: 0.6 });
  return Infinity;
}, { loop: true, maxDist: 14 });
alias('lava_ambient', 'lava');

S('lava_pop', 'blocks', 0.6, 0.3, (ctx, dest, o) => {
  const e = tone(ctx, dest, o, { type: 'sine', f: 160, f2: 60, dur: 0.16, gain: 0.3, a: 0.002, d: 0.14, s: 0.0005, r: 0.05 });
  return Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.14, gain: 0.16, a: 0.002, d: 0.12, s: 0.0008, lp: [800, 240], q: 2 }));
});

S('rain', 'weather', 0.55, 0, (ctx, dest, o) => {
  noise(ctx, dest, o, { color: 'white', dur: 1, gain: 0.2, a: 1.2, hold: true, bp: [3000], q: 0.6, lp: [7000] });
  noise(ctx, dest, o, { color: 'pink', dur: 1, gain: 0.12, a: 1.5, hold: true, lp: [1400] });
  return Infinity;
}, { loop: true });

S('wind', 'ambient', 0.4, 0, (ctx, dest, o) => {
  const t = o.t;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 'brown');
  src.loop = true;
  const lp = biquad(ctx, 'lowpass', 700, 1.6, t, 1);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0003, t);
  g.gain.linearRampToValueAtTime(0.22, t + 2.5);
  src.connect(lp); lp.connect(g); g.connect(dest);
  src.start(t, o.rng.next());
  o.srcs.push(src);
  modParam(ctx, o, lp.frequency, t, 0.07, 420, true);
  modParam(ctx, o, g.gain, t, 0.11, 0.09, true);
  return Infinity;
}, { loop: true });

S('thunder', 'weather', 1.0, 0.1, (ctx, dest, o) => {
  const g = grit(ctx, dest, 6, 0.9);
  let e = noise(ctx, g, o, { color: 'brown', dur: 2.6, gain: 0.42, a: 0.01, d: 1.9, s: 0.05, r: 0.8, lp: [2400, 90], q: 0.8 });
  e = Math.max(e, noise(ctx, g, o, { color: 'white', dur: 0.3, gain: 0.24, a: 0.003, d: 0.24, s: 0.004, hp: [500], lp: [7000, 1400] }));
  for (let i = 0; i < 4; i++) {
    e = Math.max(e, noise(ctx, g, o, { color: 'brown', at: 0.4 + i * 0.55 + o.rng.next() * 0.3, dur: 0.9, gain: 0.2 * (1 - i * 0.18), a: 0.05, d: 0.7, s: 0.01, r: 0.4, lp: [700, 120] }));
  }
  return Math.max(e, tone(ctx, g, o, { type: 'sine', f: 55, f2: 20, dur: 2.2, gain: 0.24, a: 0.02, d: 1.7, s: 0.006, r: 0.7 }));
}, { maxDist: 256, reverb: 0.5 });
alias('lightning_thunder', 'thunder');
alias('lightning_strike', 'thunder');

S('fall_small', 'players', 0.5, 0.15, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'brown', dur: 0.1, gain: 0.28, a: 0.002, d: 0.085, s: 0.0008, lp: [700, 220] });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 110, f2: 55, dur: 0.12, gain: 0.2, a: 0.002, d: 0.1, s: 0.0004, r: 0.04 }));
});
S('fall_big', 'players', 0.8, 0.1, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'brown', dur: 0.24, gain: 0.4, a: 0.002, d: 0.2, s: 0.002, lp: [900, 160] });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 90, f2: 36, dur: 0.3, gain: 0.32, a: 0.002, d: 0.26, s: 0.0005, r: 0.08 }));
});
alias('land', 'fall_small');

S('hit_generic', 'players', 0.65, 0.16, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'brown', dur: 0.075, gain: 0.3, a: 0.001, d: 0.06, s: 0.0006, lp: [1300, 340] });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 165, f2: 78, dur: 0.09, gain: 0.2, a: 0.001, d: 0.08, s: 0.0004, r: 0.03 }));
});
alias('attack_hit', 'hit_generic');
alias('punch', 'hit_generic');
S('attack_crit', 'players', 0.75, 0.1, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.11, gain: 0.28, a: 0.001, d: 0.09, s: 0.001, bp: [2400, 900], q: 2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'square', f: 660, f2: 240, dur: 0.12, gain: 0.14, a: 0.001, d: 0.1, s: 0.0004, r: 0.04 }));
});
S('attack_sweep', 'players', 0.7, 0.12, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.26, gain: 0.24, a: 0.006, d: 0.2, s: 0.006, bp: [2800, 700], q: 1.3 }));
alias('sweep', 'attack_sweep');
S('attack_nodamage', 'players', 0.5, 0.12, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'pink', dur: 0.07, gain: 0.18, a: 0.002, d: 0.06, s: 0.0005, lp: [1100, 400] }));
S('attack_knockback', 'players', 0.7, 0.12, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'brown', dur: 0.14, gain: 0.32, a: 0.002, d: 0.12, s: 0.001, lp: [1000, 220] });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 140, f2: 55, dur: 0.16, gain: 0.22, a: 0.002, d: 0.14, s: 0.0004, r: 0.05 }));
});
// player.js plays these two on a critical hit and a full-charge swing. Neither
// existed, so both landed silently.
S('crit', 'players', 0.8, 0.1, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.16, gain: 0.3, a: 0.001, d: 0.13, s: 0.001, bp: [4200, 1400], q: 2.2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 1180, f2: 1760, dur: 0.14, gain: 0.14, a: 0.001, d: 0.12, s: 0.0004, r: 0.04 }));
});
alias('critical_hit', 'crit');
S('attack_strong', 'players', 0.8, 0.1, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.13, gain: 0.34, a: 0.001, d: 0.11, s: 0.001, bp: [2200, 900], q: 1.6 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 260, f2: 120, dur: 0.15, gain: 0.2, a: 0.001, d: 0.13, s: 0.0004, r: 0.04 }));
});
S('attack_weak', 'players', 0.5, 0.12, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'pink', dur: 0.08, gain: 0.16, a: 0.002, d: 0.07, s: 0.0005, lp: [900, 350] }));

S('anvil_use', 'blocks', 0.85, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.07, gain: 0.34, a: 0.001, d: 0.055, s: 0.0008, bp: [2600, 1100], q: 2 });
  e = Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 620, dur: 0.5, gain: 0.16, a: 0.001, d: 0.45, s: 0.0004, r: 0.1 }));
  e = Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 1490, dur: 0.34, gain: 0.09, a: 0.001, d: 0.3, s: 0.0004, r: 0.08 }));
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 165, f2: 90, dur: 0.2, gain: 0.2, a: 0.001, d: 0.18, s: 0.0004, r: 0.06 }));
});
alias('anvil_land', 'anvil_use');
alias('anvil_place', 'anvil_use');
S('anvil_break', 'blocks', 0.9, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.4, gain: 0.4, a: 0.002, d: 0.32, s: 0.004, lp: [4000, 500], q: 1.2 });
  for (let i = 0; i < 5; i++) e = Math.max(e, tone(ctx, dest, o, { type: 'triangle', at: i * 0.045, f: 400 + o.rng.next() * 1200, f2: 220, dur: 0.22, gain: 0.11, a: 0.001, d: 0.2, s: 0.0004, r: 0.06 }));
  return e;
});

S('armor_equip', 'players', 0.6, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'pink', dur: 0.13, gain: 0.24, a: 0.003, d: 0.11, s: 0.001, bp: [1300, 700], q: 2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 480, f2: 320, dur: 0.16, gain: 0.1, a: 0.002, d: 0.14, s: 0.0004, r: 0.05 }));
});
for (const mat of ['leather', 'chain', 'iron', 'gold', 'diamond', 'netherite', 'turtle', 'elytra', 'generic']) alias('armor_equip_' + mat, 'armor_equip');

S('bucket_fill', 'blocks', 0.65, 0.14, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.32, gain: 0.2, a: 0.01, d: 0.26, s: 0.01, bp: [1400, 2800], q: 1.2 });
  for (let i = 0; i < 4; i++) e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.06, f: 380 + i * 110, f2: 900 + i * 200, dur: 0.07, gain: 0.1, a: 0.003, d: 0.06, s: 0.0004, r: 0.03 }));
  return e;
});
S('bucket_empty', 'blocks', 0.65, 0.14, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.3, gain: 0.26, a: 0.004, d: 0.24, s: 0.008, bp: [2600, 900], q: 1 });
  return Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.2, gain: 0.12, a: 0.004, d: 0.16, s: 0.004, lp: [800, 300] }));
});
S('bucket_fill_lava', 'blocks', 0.7, 0.12, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'brown', dur: 0.5, gain: 0.26, a: 0.02, d: 0.4, s: 0.02, lp: [500, 200] });
  return Math.max(e, noise(ctx, dest, o, { color: 'crackle', dur: 0.5, gain: 0.12, a: 0.02, d: 0.4, s: 0.01, lp: [1200] }));
});
alias('bucket_empty_lava', 'bucket_fill_lava');
S('milk', 'players', 0.6, 0.15, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 4; i++) e = Math.max(e, noise(ctx, dest, o, { color: 'white', at: i * 0.11, dur: 0.06, gain: 0.16, a: 0.004, d: 0.05, s: 0.0005, bp: [2200 + o.rng.next() * 900], q: 3 }));
  return e;
});

S('piston_extend', 'blocks', 0.7, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'pink', dur: 0.2, gain: 0.24, a: 0.004, d: 0.16, s: 0.006, lp: [1600, 700], hp: [180], q: 1.4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 190, f2: 300, dur: 0.2, gain: 0.12, a: 0.006, d: 0.17, s: 0.005, r: 0.05, lp: [1000, 1500], q: 4 }));
});
S('piston_retract', 'blocks', 0.7, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'pink', dur: 0.2, gain: 0.24, a: 0.004, d: 0.16, s: 0.006, lp: [1500, 600], hp: [170], q: 1.4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 300, f2: 180, dur: 0.2, gain: 0.12, a: 0.006, d: 0.17, s: 0.005, r: 0.05, lp: [1400, 900], q: 4 }));
});
S('dispenser_fire', 'blocks', 0.7, 0.15, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.09, gain: 0.28, a: 0.001, d: 0.075, s: 0.0008, bp: [1900, 700], q: 1.8 });
  return Math.max(e, tone(ctx, dest, o, { type: 'square', f: 340, f2: 150, dur: 0.1, gain: 0.11, a: 0.001, d: 0.09, s: 0.0004, r: 0.03 }));
});
alias('dispenser_dispense', 'dispenser_fire');
alias('dispenser_fail', 'click');
S('redstone_torch_burnout', 'blocks', 0.6, 0.2, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.18, gain: 0.2, a: 0.003, d: 0.15, s: 0.002, bp: [2800, 1100], q: 1.6 });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 520, f2: 180, dur: 0.2, gain: 0.1, a: 0.003, d: 0.17, s: 0.0004, r: 0.05 }));
});

S('portal', 'ambient', 0.42, 0, (ctx, dest, o) => {
  const base = 58;
  for (let i = 0; i < 4; i++) {
    tone(ctx, dest, o, { type: 'sawtooth', f: base * (1 + i * 0.505), dur: 1, gain: 0.07 / (1 + i * 0.4), a: 1.4, hold: true, lp: [520 + i * 220], q: 5, detune: (i - 1.5) * 11, vib: [0.14 + i * 0.06, 30] });
  }
  noise(ctx, dest, o, { color: 'sparkle', dur: 1, gain: 0.06, a: 2, hold: true, bp: [900, 0], q: 1.2 });
  return Infinity;
}, { loop: true, maxDist: 12, reverb: 0.5 });
alias('portal_ambient', 'portal');
alias('nether_portal', 'portal');

S('portal_travel', 'ambient', 0.9, 0.05, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'brown', dur: 1.5, gain: 0.3, a: 0.15, d: 1.1, s: 0.05, r: 0.4, lp: [300, 3800], q: 1.4 });
  for (let i = 0; i < 5; i++) {
    e = Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 60 * (1 + i * 0.62), f2: 380 * (1 + i * 0.62), dur: 1.4, gain: 0.09, a: 0.2, d: 1.0, s: 0.02, r: 0.35, lp: [700, 2600], q: 6, vib: [3.5, 40] }));
  }
  return e;
}, { reverb: 0.6 });
S('portal_trigger', 'ambient', 0.85, 0.08, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.8, gain: 0.24, a: 0.03, d: 0.6, s: 0.02, bp: [600, 4200], q: 1.1 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 90, f2: 700, dur: 0.75, gain: 0.16, a: 0.03, d: 0.6, s: 0.01, r: 0.2, lp: [800, 3200], q: 5 }));
}, { reverb: 0.5 });

S('enchant', 'players', 0.75, 0.06, (ctx, dest, o) => {
  let e = o.t;
  const notes = [880, 1174.7, 1318.5, 1760];
  for (let i = 0; i < 6; i++) {
    e = Math.max(e, bell(ctx, dest, o, { at: i * 0.06, f: notes[o.rng.int(notes.length)] * (o.rng.next() < 0.4 ? 0.5 : 1), dur: 0.9, ratio: 3.4, index: 2.2, gain: 0.11 }));
  }
  return Math.max(e, noise(ctx, dest, o, { color: 'sparkle', dur: 0.7, gain: 0.07, a: 0.05, d: 0.55, s: 0.004, bp: [2600, 5200], q: 1.4 }));
}, { reverb: 0.45 });
alias('enchant_table_use', 'enchant');
S('brewing_stand_brew', 'blocks', 0.55, 0.15, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.5, gain: 0.14, a: 0.02, d: 0.4, s: 0.01, bp: [2600, 1200], q: 2 });
  for (let i = 0; i < 5; i++) e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.08, f: 500 + o.rng.next() * 700, f2: 1500, dur: 0.06, gain: 0.09, a: 0.003, d: 0.05, s: 0.0004, r: 0.03 }));
  return e;
});
S('beacon_activate', 'blocks', 0.8, 0.05, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 4; i++) e = Math.max(e, bell(ctx, dest, o, { at: i * 0.1, f: 261.6 * Math.pow(2, i / 3), dur: 2.2, ratio: 2, index: 1.2, gain: 0.14 }));
  return e;
}, { reverb: 0.5 });
alias('beacon_deactivate', 'beacon_activate');
S('beacon_ambient', 'ambient', 0.35, 0, (ctx, dest, o) => {
  tone(ctx, dest, o, { type: 'sine', f: 261.6, dur: 1, gain: 0.09, a: 2, hold: true, vib: [0.2, 10] });
  tone(ctx, dest, o, { type: 'sine', f: 392, dur: 1, gain: 0.05, a: 2.5, hold: true, vib: [0.17, 12] });
  return Infinity;
}, { loop: true, maxDist: 14, reverb: 0.4 });

S('bell_use', 'blocks', 0.9, 0.03, (ctx, dest, o) => {
  let e = bell(ctx, dest, o, { f: 523.25, dur: 3.2, ratio: 2.76, index: 3.4, gain: 0.26, a: 0.002 });
  e = Math.max(e, bell(ctx, dest, o, { f: 1046.5, dur: 2.2, ratio: 5.4, index: 2.2, gain: 0.1, a: 0.002 }));
  return Math.max(e, noise(ctx, dest, o, { color: 'white', dur: 0.04, gain: 0.14, a: 0.001, d: 0.035, s: 0.0004, bp: [3600], q: 2 }));
}, { maxDist: 48, reverb: 0.45 });
alias('bell_resonate', 'bell_use');

S('totem_use', 'players', 1.0, 0.03, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 5; i++) e = Math.max(e, bell(ctx, dest, o, { at: i * 0.09, f: 329.6 * Math.pow(2, i / 4), dur: 2.4 - i * 0.2, ratio: 2.4, index: 2, gain: 0.2 }));
  return Math.max(e, noise(ctx, dest, o, { color: 'sparkle', dur: 1.4, gain: 0.1, a: 0.02, d: 1.1, s: 0.006, bp: [1800, 4600], q: 1.2 }));
}, { reverb: 0.5 });

S('firework_launch', 'ambient', 0.8, 0.12, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.85, gain: 0.24, a: 0.01, d: 0.7, s: 0.02, bp: [1200, 4200], q: 1.1 }), { maxDist: 48 });
S('firework_blast', 'ambient', 0.9, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'brown', dur: 0.5, gain: 0.42, a: 0.002, d: 0.4, s: 0.005, lp: [3200, 300] });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 130, f2: 40, dur: 0.35, gain: 0.24, a: 0.002, d: 0.3, s: 0.0005, r: 0.1 }));
}, { maxDist: 64 });
S('firework_twinkle', 'ambient', 0.6, 0.2, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 8; i++) e = Math.max(e, noise(ctx, dest, o, { color: 'white', at: i * 0.055 + o.rng.next() * 0.03, dur: 0.035, gain: 0.14, a: 0.001, d: 0.03, s: 0.0003, bp: [4200 + o.rng.next() * 3200], q: 8 }));
  return e;
}, { maxDist: 48 });

S('book_page_turn', 'players', 0.5, 0.2, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.16, gain: 0.2, a: 0.006, d: 0.13, s: 0.002, bp: [3400, 1600], q: 1.2 }));
alias('write', 'book_page_turn');
S('hoe_till', 'blocks', 0.7, 0.14, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'brown', dur: 0.17, gain: 0.32, a: 0.002, d: 0.14, s: 0.002, lp: [1600, 500], hp: [140] });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 130, f2: 70, dur: 0.14, gain: 0.16, a: 0.002, d: 0.12, s: 0.0004, r: 0.05 }));
});
alias('shovel_flatten', 'hoe_till');
S('axe_strip', 'blocks', 0.7, 0.14, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'pink', dur: 0.24, gain: 0.3, a: 0.004, d: 0.2, s: 0.004, bp: [900, 2200], q: 1.6 }));
alias('axe_scrape', 'axe_strip');
alias('axe_wax_off', 'axe_strip');
S('composter_fill', 'blocks', 0.6, 0.16, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'pink', dur: 0.22, gain: 0.26, a: 0.004, d: 0.18, s: 0.003, lp: [2200, 700] }));
alias('composter_empty', 'composter_fill');
alias('composter_ready', 'composter_fill');
S('grindstone_use', 'blocks', 0.7, 0.1, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.5, gain: 0.24, a: 0.02, d: 0.4, s: 0.02, bp: [1800, 3400], q: 1.6 }));
alias('stonecutter_use', 'grindstone_use');
alias('smithing_table_use', 'anvil_use');
alias('loom_use', 'craft');
alias('cartography_table_use', 'book_page_turn');
S('sculk_sensor_click', 'blocks', 0.6, 0.2, (ctx, dest, o) => {
  const e = bell(ctx, dest, o, { f: 440, f2: 620, dur: 0.5, ratio: 1.4, index: 1.8, gain: 0.16 });
  return Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.3, gain: 0.1, a: 0.01, d: 0.24, s: 0.003, lp: [700, 260] }));
});
S('sculk_shrieker', 'ambient', 0.95, 0.05, (ctx, dest, o) => {
  const g = grit(ctx, dest, 8, 0.85);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 68, f2: 40, dur: 2.0, gain: 0.28, a: 0.06, d: 1.5, s: 0.05, r: 0.5, lp: [900, 260], q: 5, vib: [5.5, 45] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 136, f2: 82, dur: 1.6, gain: 0.1, a: 0.08, d: 1.2, s: 0.02, r: 0.4, lp: [1300, 400] }));
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 1.8, gain: 0.12, a: 0.1, d: 1.4, s: 0.01, r: 0.4, lp: [600, 200] }));
}, { maxDist: 48, reverb: 0.5 });
S('respawn_anchor_charge', 'blocks', 0.8, 0.08, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 110, f2: 440, dur: 0.7, gain: 0.2, a: 0.02, d: 0.55, s: 0.02, r: 0.15, lp: [700, 2600], q: 6 });
  return Math.max(e, noise(ctx, dest, o, { color: 'sparkle', dur: 0.6, gain: 0.1, a: 0.03, d: 0.5, s: 0.005, bp: [1600, 3600], q: 1.4 }));
}, { reverb: 0.4 });
S('conduit_ambient', 'ambient', 0.4, 0, (ctx, dest, o) => {
  tone(ctx, dest, o, { type: 'sine', f: 320, dur: 1, gain: 0.07, a: 1.5, hold: true, vib: [0.5, 40] });
  noise(ctx, dest, o, { color: 'sparkle', dur: 1, gain: 0.05, a: 2, hold: true, bp: [2200], q: 2 });
  return Infinity;
}, { loop: true, maxDist: 16, reverb: 0.4 });
S('cave_ambience', 'ambient', 0.55, 0.25, (ctx, dest, o) => {
  const e = tone(ctx, dest, o, { type: 'sine', f: 90 + o.rng.next() * 120, f2: 55, dur: 2.4, gain: 0.14, a: 0.6, d: 1.6, s: 0.02, r: 0.8, lp: [500, 200], vib: [0.4, 25] });
  return Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 2.2, gain: 0.08, a: 0.7, d: 1.4, s: 0.006, r: 0.7, lp: [420, 160] }));
}, { reverb: 0.6 });
alias('cave', 'cave_ambience');
S('elytra_flying', 'players', 0.5, 0, (ctx, dest, o) => {
  noise(ctx, dest, o, { color: 'white', dur: 1, gain: 0.18, a: 0.5, hold: true, bp: [1600], q: 0.9 });
  return Infinity;
}, { loop: true });
S('boat_paddle_water', 'neutral', 0.5, 0.2, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.26, gain: 0.2, a: 0.03, d: 0.2, s: 0.008, bp: [900, 2600], q: 1.1 }), { cooldown: 0.1 });
alias('boat_paddle_land', 'step_gravel');
S('minecart_riding', 'neutral', 0.45, 0, (ctx, dest, o) => {
  noise(ctx, dest, o, { color: 'brown', dur: 1, gain: 0.16, a: 0.4, hold: true, bp: [420], q: 1.6 });
  tone(ctx, dest, o, { type: 'sawtooth', f: 96, dur: 1, gain: 0.05, a: 0.5, hold: true, lp: [700], q: 4 });
  return Infinity;
}, { loop: true, maxDist: 12 });
S('drown', 'players', 0.8, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'brown', dur: 0.6, gain: 0.28, a: 0.01, d: 0.48, s: 0.02, lp: [700, 250], q: 1.4 });
  for (let i = 0; i < 6; i++) e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.07, f: 300 + o.rng.next() * 500, f2: 900, dur: 0.07, gain: 0.09, a: 0.003, d: 0.06, s: 0.0004, r: 0.03 }));
  return e;
});
S('burn', 'players', 0.6, 0.15, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'crackle', dur: 0.5, gain: 0.22, a: 0.01, d: 0.4, s: 0.02, bp: [1600, 700], q: 1.2 }));
alias('on_fire', 'burn');
alias('generic_burn', 'burn');

// ---------------------------------------------------------------------------
// Musical scaffolding shared by note blocks, jukebox discs and the music engine
// ---------------------------------------------------------------------------

const SCALES = {
  penta_major: [0, 2, 4, 7, 9],
  penta_minor: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  hexatonic: [0, 2, 3, 5, 7, 10],
};
/** MIDI note number -> frequency in Hz. */
const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** Degree index -> frequency, wrapping into higher octaves. */
function degFreq(root, scale, deg) {
  const n = scale.length;
  const oct = Math.floor(deg / n);
  return NOTE(root + scale[((deg % n) + n) % n] + 12 * oct);
}

// ---- Note block instruments ------------------------------------------------
// Callers transpose with opts.pitch: 2^((note - 12) / 12) over the 25 note range.

const NOTE_INSTRUMENTS = {
  harp: { type: 'sine', f: 370, ratio: 2.01, index: 1.5, dur: 1.1, gain: 0.26 },
  pling: { type: 'triangle', f: 370, ratio: 3.02, index: 2.6, dur: 0.55, gain: 0.24 },
  bell: { type: 'sine', f: 740, ratio: 2.76, index: 3.6, dur: 2.0, gain: 0.22 },
  chime: { type: 'sine', f: 740, ratio: 4.2, index: 2.4, dur: 1.7, gain: 0.18 },
  xylophone: { type: 'sine', f: 740, ratio: 3.4, index: 3.0, dur: 0.5, gain: 0.22 },
  iron_xylophone: { type: 'triangle', f: 370, ratio: 3.0, index: 2.2, dur: 0.9, gain: 0.22 },
  flute: { type: 'sine', f: 370, ratio: 1.0, index: 0.35, dur: 0.75, gain: 0.24, a: 0.05, breath: 0.05 },
  guitar: { type: 'sawtooth', f: 185, ratio: 1.0, index: 0.5, dur: 0.7, gain: 0.2, lp: [2200, 700] },
  banjo: { type: 'sawtooth', f: 370, ratio: 2.4, index: 1.2, dur: 0.4, gain: 0.2, lp: [4200, 1400] },
  bit: { type: 'square', f: 370, ratio: 1.0, index: 0.2, dur: 0.35, gain: 0.16 },
  bass: { type: 'sine', f: 92.5, ratio: 1.0, index: 0.7, dur: 0.9, gain: 0.32 },
  didgeridoo: { type: 'sawtooth', f: 92.5, ratio: 1.0, index: 0.4, dur: 1.0, gain: 0.26, lp: [700, 300], trem: [12, 0.4] },
  cow_bell: { type: 'square', f: 555, ratio: 1.48, index: 2.2, dur: 0.4, gain: 0.18 },
};

for (const key of Object.keys(NOTE_INSTRUMENTS)) {
  const inst = NOTE_INSTRUMENTS[key];
  S('note_' + key, 'blocks', 0.75, 0, (ctx, dest, o) => {
    let e = bell(ctx, dest, o, inst);
    if (inst.breath) {
      e = Math.max(e, noise(ctx, dest, o, {
        color: 'pink', dur: inst.dur * 0.5, gain: inst.breath, a: 0.03, d: inst.dur * 0.4,
        s: inst.breath * 0.3, bp: [inst.f * 3, inst.f * 2], q: 2,
      }));
    }
    return e;
  }, { maxDist: 24 });
}
S('note_basedrum', 'blocks', 0.8, 0.05, (ctx, dest, o) => {
  const e = tone(ctx, dest, o, { type: 'sine', f: 150, f2: 42, dur: 0.28, gain: 0.42, a: 0.001, d: 0.24, s: 0.0004, r: 0.06, fixed: true });
  return Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.06, gain: 0.14, a: 0.001, d: 0.05, s: 0.0004, lp: [400], fixed: true }));
}, { maxDist: 24 });
S('note_snare', 'blocks', 0.7, 0.05, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.16, gain: 0.3, a: 0.001, d: 0.13, s: 0.0006, hp: [900], lp: [7000, 3200], fixed: true });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 210, f2: 130, dur: 0.09, gain: 0.14, a: 0.001, d: 0.08, s: 0.0004, r: 0.03, fixed: true }));
}, { maxDist: 24 });
S('note_hat', 'blocks', 0.6, 0.05, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.07, gain: 0.22, a: 0.001, d: 0.06, s: 0.0004, hp: [6000], fixed: true }), { maxDist: 24 });
alias('note_block', 'note_harp');
alias('note', 'note_harp');

// ---- Jukebox discs ---------------------------------------------------------
// Each disc is a short procedurally composed loop: bass, lead and percussion
// over a fixed scale, seeded by the disc name so a given disc always sounds
// the same.

function discSynth(cfg) {
  return (ctx, dest, o) => {
    const rng = new RNG(hashString('mc67_disc_' + cfg.key));
    const scale = SCALES[cfg.scale] || SCALES.penta_minor;
    const sd = 60 / cfg.bpm / 2;
    const steps = cfg.steps || 56;
    const root = cfg.root;
    const dly = ctx.createDelay(0.9);
    dly.delayTime.value = cfg.delay == null ? sd * 1.5 : cfg.delay;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const wet = ctx.createGain();
    wet.gain.value = cfg.wet == null ? 0.26 : cfg.wet;
    dly.connect(fb); fb.connect(dly); dly.connect(wet); wet.connect(dest);
    const lead = ctx.createGain();
    lead.gain.value = 1;
    lead.connect(dest); lead.connect(dly);
    let deg = rng.int(scale.length);
    let e = o.t;
    for (let i = 0; i < steps; i++) {
      const at = i * sd;
      if (i % 8 === 0) {
        e = Math.max(e, tone(ctx, dest, o, {
          type: cfg.bassType || 'sine', at, f: degFreq(root - 24, scale, rng.int(2) * 2),
          dur: sd * 3.2, gain: 0.24, a: 0.01, d: sd * 2.6, s: 0.02, r: 0.12, lp: [700, 300], fixed: true,
        }));
      }
      if (cfg.drums && i % 4 === 0) {
        e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at, f: 140, f2: 45, dur: 0.2, gain: 0.24, a: 0.001, d: 0.17, s: 0.0004, r: 0.05, fixed: true }));
      }
      if (cfg.drums && i % 8 === 4) {
        e = Math.max(e, noise(ctx, dest, o, { color: 'white', at, dur: 0.13, gain: 0.14, a: 0.001, d: 0.11, s: 0.0005, hp: [1100], fixed: true }));
      }
      if (cfg.hats && i % 2 === 1) {
        e = Math.max(e, noise(ctx, dest, o, { color: 'white', at, dur: 0.05, gain: 0.07, a: 0.001, d: 0.04, s: 0.0003, hp: [7000], fixed: true }));
      }
      if (rng.next() < (cfg.density == null ? 0.55 : cfg.density)) {
        deg += rng.int(5) - 2;
        if (deg < 0) deg += scale.length;
        if (deg > scale.length * 2 + 2) deg -= scale.length;
        const f = degFreq(root, scale, deg);
        if (cfg.voice === 'bell') {
          e = Math.max(e, bell(ctx, lead, o, { at, f, dur: sd * (2 + rng.int(3)), ratio: cfg.ratio || 2, index: cfg.index || 1.6, gain: 0.16, fixed: true }));
        } else if (cfg.voice === 'pluck') {
          e = Math.max(e, tone(ctx, lead, o, { type: 'triangle', at, f, dur: sd * 1.6, gain: 0.15, a: 0.004, d: sd * 1.3, s: 0.004, r: 0.06, lp: [f * 6, f * 2], q: 2, fixed: true }));
        } else if (cfg.voice === 'square') {
          e = Math.max(e, tone(ctx, lead, o, { type: 'square', at, f, dur: sd * 1.2, gain: 0.11, a: 0.003, d: sd, s: 0.006, r: 0.05, lp: [3200, 1400], fixed: true }));
        } else {
          e = Math.max(e, tone(ctx, lead, o, { type: 'sawtooth', at, f, dur: sd * 1.8, gain: 0.12, a: 0.02, d: sd * 1.4, s: 0.01, r: 0.08, lp: [f * 4, f * 1.6], q: 3, fixed: true }));
        }
      }
    }
    return e + 0.6;
  };
}

const DISCS = {
  '13': { root: 57, scale: 'phrygian', bpm: 68, voice: 'pad', density: 0.3, steps: 60, drums: false, wet: 0.4 },
  cat: { root: 60, scale: 'penta_major', bpm: 104, voice: 'square', density: 0.7, drums: true, hats: true },
  blocks: { root: 58, scale: 'penta_minor', bpm: 116, voice: 'pluck', density: 0.72, drums: true, hats: true },
  chirp: { root: 62, scale: 'dorian', bpm: 96, voice: 'bell', density: 0.62, drums: true },
  far: { root: 55, scale: 'lydian', bpm: 84, voice: 'pad', density: 0.55, drums: true },
  mall: { root: 60, scale: 'major', bpm: 92, voice: 'pluck', density: 0.6, drums: true, hats: true },
  mellohi: { root: 53, scale: 'aeolian', bpm: 76, voice: 'bell', density: 0.5, drums: true },
  stal: { root: 57, scale: 'dorian', bpm: 112, voice: 'square', density: 0.68, drums: true, hats: true },
  strad: { root: 64, scale: 'major', bpm: 88, voice: 'pad', density: 0.6, drums: true },
  ward: { root: 50, scale: 'aeolian', bpm: 72, voice: 'pad', density: 0.48, drums: true, wet: 0.4 },
  '11': { root: 45, scale: 'phrygian', bpm: 60, voice: 'pad', density: 0.28, steps: 48, wet: 0.5 },
  wait: { root: 60, scale: 'penta_major', bpm: 100, voice: 'square', density: 0.72, drums: true, hats: true },
  pigstep: { root: 51, scale: 'hexatonic', bpm: 126, voice: 'square', density: 0.75, drums: true, hats: true },
  otherside: { root: 59, scale: 'penta_major', bpm: 118, voice: 'pluck', density: 0.7, drums: true, hats: true },
  '5': { root: 54, scale: 'aeolian', bpm: 80, voice: 'bell', density: 0.52, drums: true, wet: 0.42 },
  relic: { root: 56, scale: 'hexatonic', bpm: 86, voice: 'bell', density: 0.5, drums: true, wet: 0.45 },
};
for (const key of Object.keys(DISCS)) {
  const cfg = Object.assign({ key }, DISCS[key]);
  S('music_disc_' + key, 'music', 0.7, 0, discSynth(cfg), { maxDist: 64, cooldown: 0.5 });
  alias('record_' + key, 'music_disc_' + key);
}
S('jukebox_insert', 'blocks', 0.6, 0.1, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'pink', dur: 0.08, gain: 0.22, a: 0.002, d: 0.07, s: 0.0005, lp: [1500, 600] });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 380, f2: 240, dur: 0.1, gain: 0.12, a: 0.002, d: 0.09, s: 0.0004, r: 0.04 }));
});
alias('jukebox_eject', 'jukebox_insert');

// ---------------------------------------------------------------------------
// Mob voices
//
// One parametric vocal-tract-ish generator drives idle/hurt/death for every mob
// family; the distinctive sounds (creeper hiss, enderman warp, warden sonic
// boom, ...) are hand written below the table.
// ---------------------------------------------------------------------------

/**
 * Builds a synth from a compact creature spec:
 * { type, f, f2, dur, gain, harm[], amps[], lp[], q, vib, trem, grit, breath,
 *   bcolor, bband, formant:[hz,q,db], a, d, sus, r, jit }
 */
function vox(s) {
  return (ctx, dest, o) => {
    const rng = o.rng;
    const j = 1 + (rng.next() - 0.5) * (s.jit == null ? 0.09 : s.jit);
    const dur = Math.max(0.05, (s.dur == null ? 0.5 : s.dur) * (1 + (rng.next() - 0.5) * 0.18));
    const f = (s.f == null ? 200 : s.f) * j;
    const f2 = (s.f2 == null ? f * 0.8 : s.f2) * j;
    let bus = dest;
    if (s.grit) bus = grit(ctx, bus, s.grit, s.gritMix == null ? 0.8 : s.gritMix);
    if (s.formant) bus = formant(ctx, bus, s.formant[0], s.formant[1], s.formant[2]);
    const harm = s.harm || [1, 2];
    const amps = s.amps || [1, 0.35];
    const gain = s.gain == null ? 0.28 : s.gain;
    const lp = s.lp || [Math.max(500, f * 7), Math.max(320, f * 3)];
    let e = o.t;
    for (let i = 0; i < harm.length; i++) {
      const a = gain * (amps[i] == null ? 0.25 : amps[i]);
      e = Math.max(e, tone(ctx, bus, o, {
        type: s.type || 'sawtooth', f: f * harm[i], f2: f2 * harm[i], dur,
        gain: a, a: s.a == null ? 0.02 : s.a, d: s.d == null ? dur * 0.55 : s.d,
        s: a * (s.sus == null ? 0.4 : s.sus), r: s.r == null ? 0.09 : s.r,
        lp, q: s.q == null ? 1.2 : s.q, vib: s.vib, trem: s.trem,
        detune: (rng.next() - 0.5) * 16,
      }));
    }
    if (s.breath) {
      e = Math.max(e, noise(ctx, bus, o, {
        color: s.bcolor || 'pink', dur, gain: s.breath, a: s.a == null ? 0.02 : s.a,
        d: dur * 0.6, s: s.breath * 0.35, r: 0.08,
        bp: s.bband || [f * 4, f * 2], q: s.bq == null ? 2 : s.bq,
      }));
    }
    if (s.clicks) {
      for (let i = 0; i < s.clicks; i++) {
        e = Math.max(e, noise(ctx, dest, o, {
          color: 'white', at: rng.next() * dur * 0.8, dur: 0.02, gain: gain * 0.5,
          a: 0.001, d: 0.016, s: 0.0003, bp: [1400 + rng.next() * 2600], q: 6,
        }));
      }
    }
    return e;
  };
}

/** Registers `<name>_idle`, `_hurt`, `_death`, `_step` and `_ambient` for a mob. */
function defineCreature(name, spec, extra) {
  const ex = extra || {};
  const cat = ex.category || 'neutral';
  const md = ex.maxDist || 16;
  S(name + '_idle', cat, ex.volume == null ? 0.65 : ex.volume, 0.13, vox(spec), { cooldown: 0.12, maxDist: md });
  const base = spec.f == null ? 200 : spec.f;
  const hurt = Object.assign({}, spec, {
    f: base * (ex.hurtUp || 1.3),
    f2: base * (ex.hurtUp || 1.3) * 0.62,
    dur: (spec.dur == null ? 0.5 : spec.dur) * 0.5,
    gain: (spec.gain == null ? 0.28 : spec.gain) * 1.2,
    a: 0.004, d: undefined, sus: 0.25,
    grit: (spec.grit || 0) + 9,
  });
  S(name + '_hurt', cat, ex.volume == null ? 0.8 : ex.volume * 1.1, 0.15, vox(hurt), { cooldown: 0.05, maxDist: md });
  const death = Object.assign({}, spec, {
    f: base * 1.12,
    f2: base * 0.33,
    dur: (spec.dur == null ? 0.5 : spec.dur) * 1.85,
    gain: (spec.gain == null ? 0.28 : spec.gain) * 1.12,
    a: 0.01, sus: 0.3,
  });
  S(name + '_death', cat, ex.volume == null ? 0.85 : ex.volume * 1.15, 0.07, vox(death), { maxDist: md });
  alias(name + '_ambient', name + '_idle');
  alias(name + '_angry', name + '_hurt');
  alias(name + '_step', 'step_' + (ex.step || 'grass'));
}

const CREATURES = {
  // ---- undead & nether hostiles ----
  zombie: ['hostile', { type: 'sawtooth', f: 128, f2: 96, dur: 0.85, gain: 0.30, grit: 14, lp: [900, 380], harm: [1, 2, 3], amps: [1, 0.45, 0.18], vib: [5.5, 22], breath: 0.05, formant: [520, 4, 11] }],
  zombie_villager: ['hostile', { type: 'sawtooth', f: 152, f2: 112, dur: 0.8, gain: 0.28, grit: 12, lp: [1000, 420], harm: [1, 2], amps: [1, 0.4], vib: [6, 26], breath: 0.05, formant: [640, 4, 10] }],
  husk: ['hostile', { type: 'sawtooth', f: 110, f2: 82, dur: 0.95, gain: 0.30, grit: 17, lp: [700, 300], harm: [1, 2, 3], amps: [1, 0.4, 0.14], vib: [4.5, 16], breath: 0.08, formant: [420, 3, 9] }],
  drowned: ['hostile', { type: 'sawtooth', f: 120, f2: 88, dur: 0.9, gain: 0.28, grit: 10, lp: [600, 240], harm: [1, 2], amps: [1, 0.5], vib: [7, 44], breath: 0.11, bcolor: 'brown', formant: [380, 5, 10] }],
  zombified_piglin: ['neutral', { type: 'square', f: 192, f2: 150, dur: 0.55, gain: 0.26, grit: 18, lp: [1400, 600], harm: [1, 1.5, 2], amps: [1, 0.35, 0.22], vib: [9, 46], breath: 0.08, formant: [780, 4, 9] }],
  wither_skeleton: ['hostile', { type: 'square', f: 96, f2: 70, dur: 0.7, gain: 0.26, grit: 16, lp: [800, 300], harm: [1, 2.1, 3.3], amps: [1, 0.3, 0.14], clicks: 5, formant: [300, 4, 10] }],
  // ---- arthropods & small hostiles ----
  spider: ['hostile', { type: 'sawtooth', f: 420, f2: 330, dur: 0.35, gain: 0.2, grit: 12, lp: [3200, 1400], harm: [1, 2.4], amps: [1, 0.35], vib: [24, 70], clicks: 6, formant: [1700, 6, 12] }],
  cave_spider: ['hostile', { type: 'sawtooth', f: 560, f2: 440, dur: 0.28, gain: 0.18, grit: 12, lp: [4000, 1800], harm: [1, 2.4], amps: [1, 0.35], vib: [28, 80], clicks: 6, formant: [2200, 6, 12] }],
  silverfish: ['hostile', { type: 'square', f: 900, f2: 700, dur: 0.16, gain: 0.16, lp: [5000, 2400], harm: [1, 2.7], amps: [1, 0.3], vib: [34, 90], clicks: 4 }],
  endermite: ['hostile', { type: 'square', f: 1150, f2: 880, dur: 0.14, gain: 0.15, lp: [6000, 2800], harm: [1, 2.7], amps: [1, 0.3], vib: [38, 95], clicks: 3 }],
  // ---- illagers & humanoids ----
  witch: ['hostile', { type: 'sawtooth', f: 330, f2: 420, dur: 0.5, gain: 0.24, grit: 8, lp: [2600, 1400], harm: [1, 2], amps: [1, 0.3], vib: [16, 70], trem: [13, 0.45], formant: [1250, 5, 12] }],
  evoker: ['hostile', { type: 'sawtooth', f: 168, f2: 132, dur: 0.6, gain: 0.26, grit: 10, lp: [1500, 700], harm: [1, 2, 3], amps: [1, 0.36, 0.14], vib: [7, 30], formant: [700, 4, 11] }],
  vindicator: ['hostile', { type: 'sawtooth', f: 148, f2: 118, dur: 0.5, gain: 0.28, grit: 13, lp: [1300, 620], harm: [1, 2, 3], amps: [1, 0.36, 0.14], vib: [6, 26], formant: [620, 4, 10] }],
  pillager: ['hostile', { type: 'sawtooth', f: 158, f2: 126, dur: 0.5, gain: 0.27, grit: 12, lp: [1350, 640], harm: [1, 2, 3], amps: [1, 0.34, 0.13], vib: [6.5, 28], formant: [660, 4, 10] }],
  illusioner: ['hostile', { type: 'sawtooth', f: 196, f2: 250, dur: 0.55, gain: 0.24, grit: 9, lp: [1800, 900], harm: [1, 2, 3.1], amps: [1, 0.3, 0.12], vib: [9, 45], formant: [900, 5, 11] }],
  vex: ['hostile', { type: 'square', f: 620, f2: 780, dur: 0.3, gain: 0.2, grit: 8, lp: [3600, 1800], harm: [1, 2], amps: [1, 0.3], vib: [22, 90], formant: [2100, 6, 12] }],
  piglin: ['neutral', { type: 'sawtooth', f: 210, f2: 150, dur: 0.4, gain: 0.27, grit: 16, lp: [1500, 600], harm: [1, 1.6, 2.4], amps: [1, 0.4, 0.2], vib: [12, 50], breath: 0.1, formant: [820, 4, 10] }],
  piglin_brute: ['hostile', { type: 'sawtooth', f: 172, f2: 124, dur: 0.5, gain: 0.3, grit: 18, lp: [1200, 500], harm: [1, 1.6, 2.4], amps: [1, 0.4, 0.2], vib: [10, 44], breath: 0.11, formant: [660, 4, 10] }],
  hoglin: ['hostile', { type: 'sawtooth', f: 138, f2: 100, dur: 0.6, gain: 0.3, grit: 18, lp: [1000, 420], harm: [1, 1.5, 2.3], amps: [1, 0.42, 0.2], vib: [8, 40], breath: 0.12, formant: [540, 4, 10] }],
  zoglin: ['hostile', { type: 'sawtooth', f: 126, f2: 92, dur: 0.62, gain: 0.3, grit: 20, lp: [900, 380], harm: [1, 1.5, 2.3], amps: [1, 0.42, 0.2], vib: [7, 36], breath: 0.12, formant: [500, 4, 10] }],
  villager: ['neutral', { type: 'sawtooth', f: 205, f2: 172, dur: 0.42, gain: 0.24, grit: 6, lp: [1600, 800], harm: [1, 2, 3], amps: [1, 0.32, 0.11], vib: [6, 22], formant: [850, 5, 12] }],
  wandering_trader: ['neutral', { type: 'sawtooth', f: 228, f2: 190, dur: 0.42, gain: 0.24, grit: 6, lp: [1700, 850], harm: [1, 2, 3], amps: [1, 0.32, 0.11], vib: [6, 24], formant: [900, 5, 12] }],
  // ---- aquatic & flying hostiles ----
  guardian: ['hostile', { type: 'sawtooth', f: 190, f2: 120, dur: 0.75, gain: 0.26, grit: 11, lp: [1400, 460], harm: [1, 1.5, 2.2], amps: [1, 0.4, 0.2], vib: [12, 130], trem: [9, 0.5], formant: [700, 7, 13] }],
  elder_guardian: ['hostile', { type: 'sawtooth', f: 128, f2: 82, dur: 1.05, gain: 0.3, grit: 12, lp: [1000, 340], harm: [1, 1.5, 2.2], amps: [1, 0.42, 0.2], vib: [8, 150], trem: [6, 0.55], formant: [480, 7, 13] }],
  shulker: ['hostile', { type: 'square', f: 300, f2: 210, dur: 0.35, gain: 0.24, grit: 9, lp: [2000, 800], harm: [1, 2.3], amps: [1, 0.3], vib: [15, 60], formant: [1200, 6, 12] }],
  phantom: ['hostile', { type: 'sawtooth', f: 540, f2: 900, dur: 0.55, gain: 0.24, grit: 10, lp: [4200, 2200], harm: [1, 1.5, 2], amps: [1, 0.4, 0.2], vib: [17, 110], formant: [2400, 6, 13] }],
  breeze: ['hostile', { type: 'sawtooth', f: 260, f2: 420, dur: 0.6, gain: 0.2, lp: [2600, 1200], harm: [1, 1.5], amps: [1, 0.3], vib: [11, 90], breath: 0.16, bcolor: 'white', bband: [1400, 3200] }],
  creaking: ['hostile', { type: 'sawtooth', f: 118, f2: 176, dur: 0.7, gain: 0.24, grit: 14, lp: [1600, 700], harm: [1, 2.7, 4.1], amps: [1, 0.3, 0.12], vib: [19, 60], q: 5, clicks: 4 }],
  // ---- passive land ----
  cow: ['neutral', { type: 'sawtooth', f: 168, f2: 128, dur: 1.0, gain: 0.3, grit: 7, lp: [1300, 520], harm: [1, 2, 3], amps: [1, 0.42, 0.16], vib: [5, 26], breath: 0.05, formant: [620, 4, 12] }],
  mooshroom: ['neutral', { type: 'sawtooth', f: 176, f2: 134, dur: 1.0, gain: 0.3, grit: 7, lp: [1300, 520], harm: [1, 2, 3], amps: [1, 0.42, 0.16], vib: [5, 26], breath: 0.05, formant: [640, 4, 12] }],
  pig: ['neutral', { type: 'sawtooth', f: 260, f2: 190, dur: 0.24, gain: 0.28, grit: 15, lp: [1900, 700], harm: [1, 1.6, 2.5], amps: [1, 0.45, 0.2], vib: [26, 90], breath: 0.1, formant: [1000, 5, 12] }],
  sheep: ['neutral', { type: 'sawtooth', f: 315, f2: 265, dur: 0.75, gain: 0.27, grit: 9, lp: [2400, 1000], harm: [1, 2, 3], amps: [1, 0.38, 0.16], vib: [21, 130], formant: [1150, 5, 13] }],
  chicken: ['neutral', { type: 'square', f: 780, f2: 560, dur: 0.14, gain: 0.2, grit: 8, lp: [4200, 1800], harm: [1, 2.2], amps: [1, 0.3], vib: [30, 120], clicks: 2, formant: [2400, 6, 12] }],
  rabbit: ['neutral', { type: 'square', f: 900, f2: 1150, dur: 0.11, gain: 0.16, lp: [5200, 2600], harm: [1, 2.1], amps: [1, 0.25], vib: [26, 80] }],
  armadillo: ['neutral', { type: 'sawtooth', f: 340, f2: 260, dur: 0.28, gain: 0.2, grit: 8, lp: [2200, 900], harm: [1, 2], amps: [1, 0.3], vib: [16, 60] }],
  horse: ['neutral', { type: 'sawtooth', f: 245, f2: 170, dur: 0.95, gain: 0.3, grit: 13, lp: [2200, 800], harm: [1, 2, 3], amps: [1, 0.4, 0.18], vib: [23, 150], breath: 0.1, formant: [980, 5, 13] }],
  donkey: ['neutral', { type: 'sawtooth', f: 200, f2: 300, dur: 1.0, gain: 0.3, grit: 16, lp: [1900, 700], harm: [1, 2, 3], amps: [1, 0.42, 0.2], vib: [8, 220], breath: 0.13, formant: [760, 5, 13] }],
  mule: ['neutral', { type: 'sawtooth', f: 215, f2: 300, dur: 0.95, gain: 0.3, grit: 15, lp: [2000, 750], harm: [1, 2, 3], amps: [1, 0.42, 0.2], vib: [9, 200], breath: 0.12, formant: [820, 5, 13] }],
  skeleton_horse: ['neutral', { type: 'square', f: 235, f2: 165, dur: 0.9, gain: 0.26, grit: 14, lp: [2000, 700], harm: [1, 2.2, 3.4], amps: [1, 0.32, 0.14], vib: [20, 130], clicks: 4 }],
  zombie_horse: ['neutral', { type: 'sawtooth', f: 210, f2: 150, dur: 0.95, gain: 0.27, grit: 17, lp: [1500, 560], harm: [1, 2, 3], amps: [1, 0.4, 0.18], vib: [16, 120], breath: 0.1 }],
  llama: ['neutral', { type: 'sawtooth', f: 400, f2: 300, dur: 0.5, gain: 0.25, grit: 10, lp: [2600, 1100], harm: [1, 2, 3], amps: [1, 0.35, 0.14], vib: [14, 90], breath: 0.07, formant: [1500, 5, 13] }],
  trader_llama: ['neutral', { type: 'sawtooth', f: 420, f2: 315, dur: 0.5, gain: 0.25, grit: 10, lp: [2700, 1150], harm: [1, 2, 3], amps: [1, 0.35, 0.14], vib: [14, 90], breath: 0.07, formant: [1560, 5, 13] }],
  camel: ['neutral', { type: 'sawtooth', f: 150, f2: 110, dur: 0.9, gain: 0.28, grit: 14, lp: [1200, 480], harm: [1, 1.6, 2.5], amps: [1, 0.42, 0.2], vib: [11, 60], breath: 0.13, formant: [560, 4, 12] }],
  goat: ['neutral', { type: 'sawtooth', f: 370, f2: 300, dur: 0.6, gain: 0.27, grit: 11, lp: [2600, 1100], harm: [1, 2, 3], amps: [1, 0.38, 0.15], vib: [26, 170], formant: [1400, 5, 13] }],
  panda: ['neutral', { type: 'sawtooth', f: 180, f2: 235, dur: 0.55, gain: 0.26, grit: 12, lp: [1400, 620], harm: [1, 1.7, 2.6], amps: [1, 0.4, 0.18], vib: [9, 45], breath: 0.12, formant: [700, 4, 11] }],
  polar_bear: ['neutral', { type: 'sawtooth', f: 96, f2: 72, dur: 1.1, gain: 0.32, grit: 18, lp: [800, 300], harm: [1, 1.5, 2.4], amps: [1, 0.45, 0.22], vib: [6, 30], breath: 0.13, formant: [400, 4, 11] }],
  wolf: ['neutral', { type: 'sawtooth', f: 300, f2: 240, dur: 0.28, gain: 0.29, grit: 16, lp: [2200, 800], harm: [1, 1.7, 2.6], amps: [1, 0.42, 0.2], vib: [18, 70], breath: 0.09, formant: [1050, 5, 12] }],
  fox: ['neutral', { type: 'sawtooth', f: 620, f2: 480, dur: 0.24, gain: 0.24, grit: 12, lp: [3600, 1500], harm: [1, 2, 3], amps: [1, 0.34, 0.14], vib: [24, 110], formant: [2000, 6, 13] }],
  cat: ['neutral', { type: 'sawtooth', f: 620, f2: 500, dur: 0.55, gain: 0.24, grit: 8, lp: [3200, 1400], harm: [1, 2, 3], amps: [1, 0.35, 0.14], vib: [11, 90], formant: [1700, 6, 14] }],
  ocelot: ['neutral', { type: 'sawtooth', f: 700, f2: 560, dur: 0.45, gain: 0.22, grit: 8, lp: [3600, 1600], harm: [1, 2, 3], amps: [1, 0.33, 0.13], vib: [12, 95], formant: [1900, 6, 14] }],
  parrot: ['neutral', { type: 'square', f: 1150, f2: 880, dur: 0.2, gain: 0.2, grit: 10, lp: [6000, 2600], harm: [1, 2.2], amps: [1, 0.3], vib: [32, 140] }],
  bat: ['ambient', { type: 'square', f: 2100, f2: 1500, dur: 0.09, gain: 0.15, lp: [8000, 3600], harm: [1, 2.3], amps: [1, 0.25], vib: [45, 160] }],
  bee: ['neutral', { type: 'sawtooth', f: 210, f2: 190, dur: 0.7, gain: 0.2, grit: 6, lp: [1400, 900], harm: [1, 2, 3], amps: [1, 0.4, 0.2], trem: [42, 0.6], vib: [9, 25] }],
  frog: ['neutral', { type: 'square', f: 205, f2: 165, dur: 0.3, gain: 0.24, grit: 14, lp: [1600, 700], harm: [1, 2.1, 3.2], amps: [1, 0.4, 0.18], trem: [30, 0.7], formant: [780, 7, 14] }],
  tadpole: ['neutral', { type: 'sine', f: 900, f2: 1250, dur: 0.11, gain: 0.13, lp: [3600], harm: [1], amps: [1] }],
  sniffer: ['neutral', { type: 'sawtooth', f: 132, f2: 170, dur: 0.85, gain: 0.28, grit: 11, lp: [1100, 520], harm: [1, 1.6, 2.4], amps: [1, 0.4, 0.18], vib: [6, 34], breath: 0.15, formant: [520, 4, 11] }],
  strider: ['neutral', { type: 'sawtooth', f: 240, f2: 320, dur: 0.5, gain: 0.24, grit: 12, lp: [1800, 800], harm: [1, 1.8, 2.7], amps: [1, 0.36, 0.16], vib: [13, 70], breath: 0.1 }],
  allay: ['neutral', { type: 'sine', f: 880, f2: 1180, dur: 0.42, gain: 0.2, lp: [4200, 2600], harm: [1, 2, 3], amps: [1, 0.28, 0.1], vib: [8, 60] }],
  turtle: ['neutral', { type: 'sawtooth', f: 300, f2: 230, dur: 0.35, gain: 0.2, grit: 9, lp: [1800, 800], harm: [1, 2], amps: [1, 0.3], vib: [12, 55], breath: 0.09 }],
  axolotl: ['neutral', { type: 'sine', f: 760, f2: 1050, dur: 0.24, gain: 0.18, lp: [3600, 2000], harm: [1, 2], amps: [1, 0.24], vib: [17, 70] }],
  dolphin: ['neutral', { type: 'sine', f: 1350, f2: 2400, dur: 0.35, gain: 0.22, lp: [7000, 4000], harm: [1, 2], amps: [1, 0.26], vib: [12, 200] }],
  squid: ['neutral', { type: 'sine', f: 220, f2: 160, dur: 0.4, gain: 0.16, lp: [900, 400], harm: [1, 2], amps: [1, 0.3], vib: [6, 40], breath: 0.08, bcolor: 'brown' }],
  glow_squid: ['neutral', { type: 'sine', f: 260, f2: 190, dur: 0.4, gain: 0.16, lp: [1100, 500], harm: [1, 2], amps: [1, 0.3], vib: [7, 45], breath: 0.08, bcolor: 'brown' }],
  cod: ['neutral', { type: 'sine', f: 420, f2: 300, dur: 0.16, gain: 0.13, lp: [1400, 600], harm: [1], amps: [1], breath: 0.06, bcolor: 'brown' }],
  salmon: ['neutral', { type: 'sine', f: 380, f2: 270, dur: 0.17, gain: 0.13, lp: [1300, 560], harm: [1], amps: [1], breath: 0.06, bcolor: 'brown' }],
  tropical_fish: ['neutral', { type: 'sine', f: 520, f2: 380, dur: 0.14, gain: 0.12, lp: [1700, 700], harm: [1], amps: [1], breath: 0.05, bcolor: 'brown' }],
  pufferfish: ['neutral', { type: 'sine', f: 300, f2: 640, dur: 0.24, gain: 0.16, lp: [1600, 900], harm: [1, 2], amps: [1, 0.3], vib: [16, 70] }],
  iron_golem: ['neutral', { type: 'square', f: 92, f2: 74, dur: 0.7, gain: 0.3, grit: 9, lp: [1600, 500], harm: [1, 2.7, 4.3, 6.1], amps: [1, 0.4, 0.24, 0.12], q: 5, clicks: 3 }],
  snow_golem: ['neutral', { type: 'sine', f: 220, f2: 170, dur: 0.4, gain: 0.2, lp: [1400, 600], harm: [1, 2], amps: [1, 0.3], breath: 0.14, bcolor: 'white' }],
  ravager: ['hostile', { type: 'sawtooth', f: 82, f2: 62, dur: 1.1, gain: 0.34, grit: 22, lp: [800, 260], harm: [1, 1.5, 2.3, 3.1], amps: [1, 0.5, 0.26, 0.12], vib: [5, 26], breath: 0.14, formant: [340, 4, 12] }],
  warden: ['hostile', { type: 'sawtooth', f: 62, f2: 44, dur: 1.6, gain: 0.34, grit: 20, lp: [700, 220], harm: [1, 1.5, 2.2, 3.3], amps: [1, 0.5, 0.24, 0.1], vib: [4, 34], breath: 0.14, formant: [260, 4, 12] }],
  armor_stand: ['neutral', { type: 'triangle', f: 300, f2: 220, dur: 0.14, gain: 0.16, lp: [2400, 900], harm: [1, 2.4], amps: [1, 0.3], clicks: 2 }],
};

for (const name of Object.keys(CREATURES)) {
  const row = CREATURES[name];
  defineCreature(name, row[1], Object.assign({ category: row[0] }, row[2]));
}

// Step materials that differ from the default grass footfall.
for (const [mob, mat] of [
  ['iron_golem', 'metal'], ['ravager', 'gravel'], ['warden', 'sculk'], ['zombie', 'gravel'],
  ['husk', 'sand'], ['skeleton_horse', 'stone'], ['horse', 'stone'], ['donkey', 'stone'],
  ['mule', 'stone'], ['camel', 'sand'], ['polar_bear', 'snow'], ['snow_golem', 'snow'],
  ['strider', 'netherrack'], ['hoglin', 'netherrack'], ['zoglin', 'netherrack'],
  ['piglin', 'netherrack'], ['piglin_brute', 'netherrack'], ['spider', 'wool'],
  ['turtle', 'sand'], ['armor_stand', 'wood'],
]) alias(mob + '_step', 'step_' + mat);

// ---- Skeletons: dry bone rattles ------------------------------------------

function rattle(cfg) {
  return (ctx, dest, o) => {
    const rng = o.rng;
    const n = cfg.n || 7;
    let e = o.t;
    for (let i = 0; i < n; i++) {
      const at = i * (cfg.gap || 0.048) * (0.6 + rng.next() * 0.8);
      const f = (cfg.f || 1500) * (0.55 + rng.next() * 1.05);
      e = Math.max(e, noise(ctx, dest, o, {
        color: 'white', at, dur: 0.022, r: 0.02, gain: (cfg.gain || 0.24) * (0.55 + rng.next() * 0.65),
        a: 0.001, d: 0.018, s: 0.0003, bp: [f], q: cfg.q || 7,
      }));
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'triangle', at, f: f * 0.7, dur: 0.05, gain: (cfg.gain || 0.24) * 0.22,
        a: 0.001, d: 0.045, s: 0.0003, r: 0.02,
      }));
    }
    if (cfg.moan) {
      e = Math.max(e, tone(ctx, dest, o, {
        type: 'sawtooth', f: cfg.moan, f2: cfg.moan * 0.68, dur: 0.45, gain: 0.11,
        a: 0.03, d: 0.34, s: 0.012, r: 0.12, lp: [800, 320], q: 3, vib: [6, 25],
      }));
    }
    return e;
  };
}

for (const [mob, cfg] of [
  ['skeleton', { f: 1500, n: 7, gain: 0.26, moan: 0 }],
  ['stray', { f: 1750, n: 8, gain: 0.24, moan: 0 }],
  ['bogged', { f: 1250, n: 8, gain: 0.24, moan: 130 }],
]) {
  S(mob + '_idle', 'hostile', 0.7, 0.12, rattle(cfg), { cooldown: 0.1 });
  S(mob + '_hurt', 'hostile', 0.8, 0.14, rattle(Object.assign({}, cfg, { n: 5, gap: 0.028, gain: 0.32, moan: (cfg.f || 1500) * 0.14 })), { cooldown: 0.05 });
  S(mob + '_death', 'hostile', 0.85, 0.06, rattle(Object.assign({}, cfg, { n: 13, gap: 0.05, gain: 0.3, moan: (cfg.f || 1500) * 0.09 })));
  alias(mob + '_ambient', mob + '_idle');
  alias(mob + '_angry', mob + '_hurt');
  alias(mob + '_step', 'step_stone');
}
alias('skeleton_shoot', 'bow');
alias('wither_skeleton_step', 'step_stone');

// ---- Creeper ---------------------------------------------------------------

S('creeper_hiss', 'hostile', 0.9, 0.08, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 1.35, gain: 0.32, a: 0.05, d: 1.0, s: 0.12, r: 0.25, bp: [2600, 5200], q: 0.9 });
  e = Math.max(e, noise(ctx, dest, o, { color: 'pink', dur: 1.3, gain: 0.16, a: 0.06, d: 1.0, s: 0.06, r: 0.25, bp: [900, 1900], q: 1.6 }));
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 140, f2: 240, dur: 1.3, gain: 0.06, a: 0.1, d: 1.0, s: 0.02, r: 0.25, lp: [700, 1400], q: 4 }));
}, { maxDist: 24 });
alias('creeper_primed', 'creeper_hiss');
alias('creeper_fuse', 'creeper_hiss');
alias('creeper_idle', 'creeper_hiss');
alias('creeper_ambient', 'creeper_hiss');
S('creeper_hurt', 'hostile', 0.85, 0.14, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.3, gain: 0.32, a: 0.004, d: 0.24, s: 0.02, bp: [3400, 1400], q: 1.1 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 380, f2: 190, dur: 0.28, gain: 0.14, a: 0.004, d: 0.24, s: 0.01, r: 0.07, lp: [2200, 800], q: 3 }));
});
S('creeper_death', 'hostile', 0.9, 0.08, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.7, gain: 0.3, a: 0.006, d: 0.55, s: 0.02, r: 0.15, bp: [3000, 700], q: 1 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 330, f2: 90, dur: 0.7, gain: 0.16, a: 0.006, d: 0.56, s: 0.01, r: 0.16, lp: [1800, 400], q: 3, vib: [7, 40] }));
});
alias('creeper_step', 'step_grass');

// ---- Enderman --------------------------------------------------------------

S('enderman_idle', 'hostile', 0.7, 0.15, (ctx, dest, o) => {
  const g = grit(ctx, dest, 11, 0.8);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 74, f2: 96, dur: 0.9, gain: 0.24, a: 0.05, d: 0.62, s: 0.05, r: 0.2, lp: [700, 380], q: 5, vib: [3.4, 120] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 148, f2: 118, dur: 0.85, gain: 0.09, a: 0.06, d: 0.6, s: 0.02, r: 0.2, lp: [1200, 500], vib: [4.6, 90] }));
  return Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.8, gain: 0.06, a: 0.08, d: 0.55, s: 0.008, r: 0.18, bp: [420, 900], q: 2 }));
}, { maxDist: 20, reverb: 0.3 });
alias('enderman_ambient', 'enderman_idle');
S('enderman_scream', 'hostile', 0.95, 0.1, (ctx, dest, o) => {
  const g = grit(ctx, dest, 18, 0.85);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 190, f2: 430, dur: 0.85, gain: 0.3, a: 0.01, d: 0.65, s: 0.06, r: 0.2, lp: [2600, 4200], q: 4, vib: [9, 170] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 95, f2: 215, dur: 0.85, gain: 0.14, a: 0.01, d: 0.66, s: 0.03, r: 0.2, lp: [1600, 2600] }));
  return Math.max(e, noise(ctx, g, o, { color: 'white', dur: 0.8, gain: 0.12, a: 0.02, d: 0.6, s: 0.015, r: 0.2, bp: [1800, 3600], q: 1.2 }));
}, { maxDist: 32, reverb: 0.35 });
alias('enderman_angry', 'enderman_scream');
alias('enderman_hurt', 'enderman_scream');
alias('enderman_death', 'enderman_scream');
S('enderman_teleport', 'hostile', 0.8, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.34, gain: 0.24, a: 0.004, d: 0.28, s: 0.006, bp: [5200, 700], q: 1.2 });
  for (let i = 0; i < 4; i++) {
    e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.02, f: 1700 - i * 260, f2: 190, dur: 0.3, gain: 0.11, a: 0.002, d: 0.26, s: 0.001, r: 0.07 }));
  }
  return e;
}, { maxDist: 24, reverb: 0.3 });
alias('enderman_warp', 'enderman_teleport');
alias('enderman_stare', 'enderman_scream');
alias('enderman_step', 'step_stone');
alias('endermite_step', 'step_stone');
alias('chorus_fruit_teleport', 'enderman_teleport');

// ---- Ghast -----------------------------------------------------------------

S('ghast_idle', 'hostile', 0.85, 0.08, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sine', f: 300, f2: 210, dur: 1.9, gain: 0.24, a: 0.35, d: 1.2, s: 0.08, r: 0.55, lp: [1400, 700], vib: [3.2, 60] });
  e = Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 452, f2: 316, dur: 1.85, gain: 0.09, a: 0.4, d: 1.2, s: 0.03, r: 0.55, lp: [2000, 900], vib: [3.6, 70] }));
  return Math.max(e, noise(ctx, dest, o, { color: 'pink', dur: 1.7, gain: 0.05, a: 0.4, d: 1.1, s: 0.008, r: 0.5, bp: [900, 1600], q: 2 }));
}, { maxDist: 64, reverb: 0.4 });
alias('ghast_moan', 'ghast_idle');
alias('ghast_ambient', 'ghast_idle');
S('ghast_scream', 'hostile', 1.0, 0.08, (ctx, dest, o) => {
  const g = grit(ctx, dest, 9, 0.85);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 420, f2: 760, dur: 1.1, gain: 0.3, a: 0.02, d: 0.85, s: 0.06, r: 0.28, lp: [2800, 4400], q: 3, vib: [7.5, 190] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 210, f2: 380, dur: 1.05, gain: 0.12, a: 0.02, d: 0.8, s: 0.03, r: 0.28, lp: [1800, 2800] }));
  return Math.max(e, noise(ctx, g, o, { color: 'white', dur: 1.0, gain: 0.09, a: 0.04, d: 0.78, s: 0.012, r: 0.26, bp: [2200, 3800], q: 1.3 }));
}, { maxDist: 96, reverb: 0.45 });
alias('ghast_hurt', 'ghast_scream');
alias('ghast_death', 'ghast_scream');
alias('ghast_warn', 'ghast_scream');
S('ghast_shoot', 'hostile', 0.9, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'brown', dur: 0.6, gain: 0.3, a: 0.01, d: 0.48, s: 0.02, r: 0.14, lp: [2600, 500], q: 1.1 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 300, f2: 90, dur: 0.55, gain: 0.16, a: 0.01, d: 0.45, s: 0.01, r: 0.14, lp: [1600, 400], q: 3 }));
}, { maxDist: 64 });
alias('fireball_shoot', 'ghast_shoot');
alias('blaze_shoot', 'ghast_shoot');

// ---- Blaze -----------------------------------------------------------------

S('blaze_idle', 'hostile', 0.7, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'crackle', dur: 1.0, gain: 0.24, a: 0.15, d: 0.7, s: 0.05, r: 0.25, bp: [1400, 2600], q: 1.1 });
  e = Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.95, gain: 0.14, a: 0.2, d: 0.65, s: 0.03, r: 0.25, lp: [700, 380] }));
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 118, f2: 88, dur: 0.9, gain: 0.07, a: 0.2, d: 0.62, s: 0.015, r: 0.24, lp: [600, 300], q: 4, vib: [5, 30] }));
}, { maxDist: 24 });
alias('blaze_breath', 'blaze_idle');
alias('blaze_ambient', 'blaze_idle');
alias('blaze_burn', 'blaze_idle');
S('blaze_hurt', 'hostile', 0.85, 0.14, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.32, gain: 0.3, a: 0.004, d: 0.26, s: 0.01, bp: [3200, 1200], q: 1.2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 420, f2: 210, dur: 0.3, gain: 0.16, a: 0.004, d: 0.26, s: 0.008, r: 0.08, lp: [2400, 800], q: 4 }));
});
S('blaze_death', 'hostile', 0.9, 0.08, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'crackle', dur: 0.9, gain: 0.28, a: 0.01, d: 0.7, s: 0.01, r: 0.2, bp: [2600, 700], q: 1.1 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 300, f2: 70, dur: 0.85, gain: 0.16, a: 0.01, d: 0.7, s: 0.008, r: 0.2, lp: [1800, 400], q: 4, vib: [6, 40] }));
});
alias('blaze_step', 'step_netherrack');

// ---- Slimes ----------------------------------------------------------------

function squish(cfg) {
  return (ctx, dest, o) => {
    const dur = cfg.dur || 0.24;
    let e = tone(ctx, dest, o, {
      type: 'sawtooth', f: cfg.f, f2: cfg.f * (cfg.up ? 1.9 : 0.42), dur,
      gain: 0.32, a: 0.008, d: dur * 0.8, s: 0.004, r: 0.06, lp: [cfg.f * 6, cfg.f * 2], q: 7,
    });
    e = Math.max(e, noise(ctx, dest, o, {
      color: 'brown', dur: dur * 0.9, gain: 0.16, a: 0.006, d: dur * 0.7, s: 0.003,
      lp: [cfg.f * 5, cfg.f * 1.6], q: 3,
    }));
    return Math.max(e, tone(ctx, dest, o, {
      type: 'sine', f: cfg.f * 0.5, f2: cfg.f * 0.25, dur: dur * 0.8, gain: 0.18,
      a: 0.006, d: dur * 0.6, s: 0.003, r: 0.05,
    }));
  };
}
S('slime_squish', 'hostile', 0.7, 0.2, squish({ f: 210 }));
alias('slime_idle', 'slime_squish');
alias('slime_ambient', 'slime_squish');
alias('slime_attack', 'slime_squish');
alias('slime_step', 'slime_squish');
alias('slime_block_step', 'step_slime');
S('slime_jump', 'hostile', 0.7, 0.2, squish({ f: 250, up: true, dur: 0.2 }));
S('slime_hurt', 'hostile', 0.8, 0.18, squish({ f: 320, dur: 0.18 }));
S('slime_death', 'hostile', 0.85, 0.1, squish({ f: 180, dur: 0.5 }));
S('magma_cube_squish', 'hostile', 0.7, 0.2, (ctx, dest, o) => {
  const e = squish({ f: 165, dur: 0.28 })(ctx, dest, o);
  return Math.max(e, noise(ctx, dest, o, { color: 'crackle', dur: 0.3, gain: 0.12, a: 0.01, d: 0.24, s: 0.004, bp: [1600, 800], q: 1.4 }));
});
alias('magma_cube_idle', 'magma_cube_squish');
alias('magma_cube_ambient', 'magma_cube_squish');
alias('magma_cube_jump', 'magma_cube_squish');
alias('magma_cube_step', 'magma_cube_squish');
S('magma_cube_hurt', 'hostile', 0.8, 0.18, squish({ f: 260, dur: 0.2 }));
S('magma_cube_death', 'hostile', 0.85, 0.1, squish({ f: 140, dur: 0.55 }));

// ---- Signature calls for the remaining families ---------------------------

S('wolf_growl', 'neutral', 0.75, 0.12, (ctx, dest, o) => {
  const g = grit(ctx, dest, 20, 0.85);
  return tone(ctx, g, o, { type: 'sawtooth', f: 118, f2: 96, dur: 0.85, gain: 0.28, a: 0.06, d: 0.6, s: 0.08, r: 0.18, lp: [900, 420], q: 4, trem: [33, 0.6], vib: [6, 20] });
});
S('wolf_howl', 'neutral', 0.9, 0.08, (ctx, dest, o) => {
  const e = tone(ctx, dest, o, { type: 'sawtooth', f: 380, f2: 520, dur: 1.7, gain: 0.26, a: 0.25, d: 1.1, s: 0.09, r: 0.5, lp: [2400, 1400], q: 3, vib: [4.5, 55] });
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 760, f2: 1040, dur: 1.6, gain: 0.09, a: 0.3, d: 1.0, s: 0.03, r: 0.5, lp: [3200, 2000] }));
}, { maxDist: 48, reverb: 0.35 });
S('wolf_whine', 'neutral', 0.6, 0.14, (ctx, dest, o) =>
  tone(ctx, dest, o, { type: 'sawtooth', f: 620, f2: 880, dur: 0.42, gain: 0.2, a: 0.04, d: 0.32, s: 0.02, r: 0.1, lp: [3000, 1800], q: 4, vib: [14, 90] }));
S('wolf_pant', 'neutral', 0.45, 0.2, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 4; i++) e = Math.max(e, noise(ctx, dest, o, { color: 'pink', at: i * 0.13, dur: 0.09, gain: 0.14, a: 0.02, d: 0.07, s: 0.002, bp: [1200, 2200], q: 1.6 }));
  return e;
});
alias('wolf_bark', 'wolf_idle');
alias('wolf_shake', 'wolf_pant');
alias('dog_bark', 'wolf_idle');

S('cat_purr', 'neutral', 0.5, 0.12, (ctx, dest, o) => {
  const g = grit(ctx, dest, 8, 0.8);
  return tone(ctx, g, o, { type: 'sawtooth', f: 62, dur: 1.5, gain: 0.24, a: 0.2, d: 1.0, s: 0.1, r: 0.35, lp: [560, 380], q: 3, trem: [26, 0.75] });
});
S('cat_hiss', 'neutral', 0.7, 0.14, (ctx, dest, o) =>
  noise(ctx, dest, o, { color: 'white', dur: 0.5, gain: 0.3, a: 0.02, d: 0.38, s: 0.03, bp: [4200, 6400], q: 0.9 }));
alias('cat_meow', 'cat_idle');
alias('cat_beg', 'cat_idle');
alias('cat_stray_ambient', 'cat_idle');
alias('ocelot_hiss', 'cat_hiss');

S('villager_no', 'neutral', 0.75, 0.1, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 2; i++) {
    e = Math.max(e, vox({ type: 'sawtooth', f: 175 - i * 22, f2: 140 - i * 20, dur: 0.2, gain: 0.26, grit: 8, lp: [1300, 620], harm: [1, 2, 3], amps: [1, 0.34, 0.12], vib: [7, 24], formant: [700, 5, 12] })(ctx, dest, Object.assign({}, o, { t: o.t + i * 0.24 })));
  }
  return e;
});
S('villager_yes', 'neutral', 0.75, 0.1, vox({ type: 'sawtooth', f: 220, f2: 300, dur: 0.34, gain: 0.26, grit: 7, lp: [1700, 900], harm: [1, 2, 3], amps: [1, 0.32, 0.11], vib: [6, 26], formant: [950, 5, 12] }));
alias('villager_hmm', 'villager_idle');
alias('villager_trade', 'villager_yes');
alias('villager_celebrate', 'villager_yes');
alias('villager_work', 'villager_idle');
alias('wandering_trader_yes', 'villager_yes');
alias('wandering_trader_no', 'villager_no');

S('iron_golem_clank', 'neutral', 0.85, 0.1, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'white', dur: 0.08, gain: 0.3, a: 0.001, d: 0.065, s: 0.0008, bp: [2200, 900], q: 2.5 });
  for (const [f, a] of [[164, 0.2], [418, 0.13], [712, 0.09], [1180, 0.05]]) {
    e = Math.max(e, tone(ctx, dest, o, { type: 'triangle', f, dur: 0.75, gain: a, a: 0.001, d: 0.68, s: 0.0004, r: 0.12 }));
  }
  return e;
}, { maxDist: 24 });
alias('iron_golem_attack', 'iron_golem_clank');
alias('iron_golem_repair', 'iron_golem_clank');
alias('iron_golem_damage', 'iron_golem_clank');

S('witch_cackle', 'hostile', 0.8, 0.1, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 5; i++) {
    e = Math.max(e, tone(ctx, dest, o, {
      type: 'sawtooth', at: i * 0.13, f: 380 + o.rng.next() * 160, f2: 260, dur: 0.1,
      gain: 0.24, a: 0.006, d: 0.085, s: 0.002, r: 0.04, lp: [2600, 1200], q: 5, vib: [24, 90],
    }));
  }
  return e;
});
alias('witch_idle', 'witch_cackle');
alias('witch_ambient', 'witch_cackle');
alias('witch_celebrate', 'witch_cackle');
alias('witch_drink', 'drink');
alias('witch_throw', 'arrow_whoosh');

S('dragon_growl', 'hostile', 1.0, 0.06, (ctx, dest, o) => {
  const g = grit(ctx, dest, 14, 0.9);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 52, f2: 40, dur: 2.6, gain: 0.34, a: 0.25, d: 1.8, s: 0.1, r: 0.7, lp: [700, 240], q: 4, vib: [3, 30], trem: [7, 0.35] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 104, f2: 78, dur: 2.5, gain: 0.13, a: 0.3, d: 1.7, s: 0.04, r: 0.7, lp: [1100, 400] }));
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 2.4, gain: 0.12, a: 0.35, d: 1.6, s: 0.02, r: 0.7, lp: [520, 200] }));
}, { maxDist: 128, reverb: 0.5 });
S('dragon_roar', 'hostile', 1.0, 0.05, (ctx, dest, o) => {
  const g = grit(ctx, dest, 22, 0.9);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 62, f2: 148, dur: 2.2, gain: 0.4, a: 0.06, d: 1.5, s: 0.14, r: 0.6, lp: [900, 2600], q: 5, vib: [4.5, 70] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 124, f2: 296, dur: 2.1, gain: 0.16, a: 0.07, d: 1.5, s: 0.05, r: 0.6, lp: [1400, 3200] }));
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 2.0, gain: 0.18, a: 0.08, d: 1.4, s: 0.03, r: 0.6, bp: [400, 1600], q: 1.2 }));
}, { maxDist: 160, reverb: 0.55 });
alias('ender_dragon_growl', 'dragon_growl');
alias('ender_dragon_idle', 'dragon_growl');
alias('ender_dragon_ambient', 'dragon_growl');
alias('ender_dragon_hurt', 'dragon_roar');
alias('ender_dragon_death', 'dragon_roar');
alias('dragon_hurt', 'dragon_roar');
alias('dragon_death', 'dragon_roar');
S('dragon_flap', 'hostile', 0.9, 0.12, (ctx, dest, o) => {
  let e = noise(ctx, dest, o, { color: 'brown', dur: 0.7, gain: 0.34, a: 0.12, d: 0.5, s: 0.03, r: 0.2, lp: [420, 900], q: 1.4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sine', f: 46, f2: 26, dur: 0.6, gain: 0.2, a: 0.1, d: 0.45, s: 0.01, r: 0.18 }));
}, { maxDist: 96 });
alias('ender_dragon_flap', 'dragon_flap');
alias('dragon_shoot', 'ghast_shoot');

S('wither_spawn', 'hostile', 1.0, 0.03, (ctx, dest, o) => {
  const g = grit(ctx, dest, 12, 0.9);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 44, f2: 132, dur: 3.0, gain: 0.34, a: 1.2, d: 1.6, s: 0.16, r: 0.8, lp: [400, 2200], q: 6, vib: [2.5, 60] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 66, f2: 198, dur: 2.9, gain: 0.14, a: 1.3, d: 1.5, s: 0.06, r: 0.8, lp: [700, 2600] }));
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 2.8, gain: 0.2, a: 1.0, d: 1.6, s: 0.05, r: 0.8, lp: [300, 2400], q: 1.2 }));
}, { maxDist: 160, reverb: 0.55 });
S('wither_shoot', 'hostile', 0.9, 0.1, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 300, f2: 96, dur: 0.5, gain: 0.28, a: 0.006, d: 0.4, s: 0.01, r: 0.13, lp: [2200, 500], q: 5, vib: [11, 70] });
  return Math.max(e, noise(ctx, dest, o, { color: 'brown', dur: 0.45, gain: 0.2, a: 0.006, d: 0.36, s: 0.008, bp: [1400, 400], q: 1.4 }));
}, { maxDist: 64 });
S('wither_idle', 'hostile', 0.9, 0.08, (ctx, dest, o) => {
  const g = grit(ctx, dest, 16, 0.88);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 68, f2: 52, dur: 1.5, gain: 0.28, a: 0.2, d: 1.0, s: 0.08, r: 0.4, lp: [800, 300], q: 5, vib: [4, 45] });
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 1.4, gain: 0.1, a: 0.25, d: 0.95, s: 0.015, r: 0.4, lp: [500, 220] }));
}, { maxDist: 96, reverb: 0.4 });
alias('wither_ambient', 'wither_idle');
alias('wither_hurt', 'wither_shoot');
alias('wither_death', 'wither_spawn');
alias('wither_break_block', 'dig_stone');

S('warden_heartbeat', 'hostile', 0.85, 0.04, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 2; i++) {
    e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.26, f: 48, f2: 27, dur: 0.3, gain: 0.42 - i * 0.14, a: 0.006, d: 0.26, s: 0.0006, r: 0.08 }));
    e = Math.max(e, noise(ctx, dest, o, { color: 'brown', at: i * 0.26, dur: 0.16, gain: 0.12, a: 0.004, d: 0.13, s: 0.0006, lp: [220] }));
  }
  return e;
}, { maxDist: 40, reverb: 0.4 });
S('warden_sonic_boom', 'hostile', 1.0, 0.03, (ctx, dest, o) => {
  const g = grit(ctx, dest, 24, 0.9);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 150, f2: 34, dur: 1.6, gain: 0.42, a: 0.02, d: 1.2, s: 0.05, r: 0.5, lp: [3200, 260], q: 7, vib: [5, 90] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 75, f2: 22, dur: 1.6, gain: 0.2, a: 0.02, d: 1.2, s: 0.02, r: 0.5, lp: [1400, 200] }));
  e = Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 1.5, gain: 0.22, a: 0.03, d: 1.1, s: 0.02, r: 0.5, lp: [4200, 180], q: 1.1 }));
  return Math.max(e, noise(ctx, dest, o, { color: 'white', dur: 0.3, gain: 0.16, a: 0.004, d: 0.25, s: 0.002, hp: [1800] }));
}, { maxDist: 128, reverb: 0.55 });
S('warden_roar', 'hostile', 1.0, 0.05, (ctx, dest, o) => {
  const g = grit(ctx, dest, 22, 0.9);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 56, f2: 128, dur: 2.4, gain: 0.38, a: 0.15, d: 1.7, s: 0.12, r: 0.6, lp: [700, 2000], q: 6, vib: [3.5, 60] });
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 2.3, gain: 0.18, a: 0.2, d: 1.6, s: 0.03, r: 0.6, lp: [420, 1400] }));
}, { maxDist: 128, reverb: 0.55 });
alias('warden_emerge', 'warden_roar');
alias('warden_sniff', 'warden_heartbeat');
alias('warden_listening', 'warden_heartbeat');
alias('warden_nearby', 'warden_heartbeat');

S('bee_buzz', 'neutral', 0.55, 0.15, (ctx, dest, o) => {
  const g = grit(ctx, dest, 6, 0.8);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 205, f2: 232, dur: 1.1, gain: 0.2, a: 0.1, d: 0.8, s: 0.07, r: 0.25, lp: [1400, 1000], q: 3, trem: [46, 0.55], vib: [7, 30] });
  return Math.max(e, tone(ctx, g, o, { type: 'square', f: 410, f2: 464, dur: 1.05, gain: 0.05, a: 0.12, d: 0.75, s: 0.015, r: 0.25, lp: [2000, 1400] }));
}, { maxDist: 12 });
alias('bee_loop', 'bee_buzz');
alias('bee_pollinate', 'bee_buzz');
S('bee_sting', 'neutral', 0.7, 0.14, (ctx, dest, o) =>
  tone(ctx, dest, o, { type: 'square', f: 900, f2: 380, dur: 0.13, gain: 0.2, a: 0.002, d: 0.11, s: 0.001, r: 0.04, lp: [4200, 1600] }));
alias('bat_squeak', 'bat_idle');
S('bat_takeoff', 'ambient', 0.5, 0.18, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 5; i++) e = Math.max(e, noise(ctx, dest, o, { color: 'pink', at: i * 0.075, dur: 0.05, gain: 0.16, a: 0.005, d: 0.04, s: 0.001, bp: [1200, 2600], q: 1.6 }));
  return e;
});
alias('horse_neigh', 'horse_idle');
S('horse_gallop', 'neutral', 0.6, 0.18, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 4; i++) {
    e = Math.max(e, noise(ctx, dest, o, { color: 'brown', at: i * 0.09, dur: 0.07, gain: 0.24, a: 0.002, d: 0.06, s: 0.0006, lp: [1100, 320], hp: [120] }));
    e = Math.max(e, tone(ctx, dest, o, { type: 'sine', at: i * 0.09, f: 120, f2: 62, dur: 0.08, gain: 0.14, a: 0.002, d: 0.07, s: 0.0004, r: 0.03 }));
  }
  return e;
}, { cooldown: 0.2 });
alias('horse_angry', 'horse_hurt');
alias('horse_eat', 'eat');
alias('horse_saddle', 'armor_equip');
alias('horse_jump', 'horse_gallop');
alias('horse_breathe', 'wolf_pant');
S('llama_spit', 'neutral', 0.65, 0.15, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.16, gain: 0.26, a: 0.004, d: 0.13, s: 0.002, bp: [2800, 1100], q: 1.4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 520, f2: 220, dur: 0.15, gain: 0.12, a: 0.004, d: 0.13, s: 0.0006, r: 0.05, lp: [2600, 900], q: 4 }));
});
alias('llama_swag', 'armor_equip');
alias('llama_angry', 'llama_hurt');
alias('llama_eat', 'eat');
S('fox_sniff', 'neutral', 0.5, 0.2, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 3; i++) e = Math.max(e, noise(ctx, dest, o, { color: 'pink', at: i * 0.1, dur: 0.07, gain: 0.16, a: 0.015, d: 0.055, s: 0.001, bp: [1600, 3000], q: 1.8 }));
  return e;
});
alias('fox_bite', 'hit_generic');
alias('fox_screech', 'fox_hurt');
alias('fox_eat', 'eat');
alias('fox_spit', 'llama_spit');
S('panda_sneeze', 'neutral', 0.75, 0.12, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 260, f2: 150, dur: 0.22, gain: 0.28, a: 0.004, d: 0.18, s: 0.004, r: 0.06, lp: [2400, 700], q: 3 });
  return Math.max(e, noise(ctx, dest, o, { color: 'white', dur: 0.24, gain: 0.28, a: 0.003, d: 0.2, s: 0.003, bp: [3400, 1200], q: 1.1 }));
});
alias('panda_pre_sneeze', 'fox_sniff');
alias('panda_bite', 'hit_generic');
alias('panda_cant_breed', 'panda_hurt');
alias('panda_eat', 'eat');
S('goat_horn', 'neutral', 0.95, 0.04, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 174.6, dur: 2.0, gain: 0.24, a: 0.06, d: 1.4, s: 0.1, r: 0.5, lp: [1100, 700], q: 3, vib: [4.5, 14] });
  e = Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 349.2, dur: 1.9, gain: 0.12, a: 0.07, d: 1.3, s: 0.04, r: 0.5, lp: [1600, 900] }));
  return Math.max(e, tone(ctx, dest, o, { type: 'triangle', f: 523.8, dur: 1.8, gain: 0.06, a: 0.09, d: 1.2, s: 0.02, r: 0.5 }));
}, { maxDist: 128, reverb: 0.45 });
alias('goat_screaming', 'goat_hurt');
alias('goat_ram_impact', 'attack_knockback');
alias('goat_prepare_ram', 'goat_idle');
alias('frog_croak', 'frog_idle');
S('frog_tongue', 'neutral', 0.6, 0.18, (ctx, dest, o) =>
  tone(ctx, dest, o, { type: 'sine', f: 1400, f2: 300, dur: 0.11, gain: 0.2, a: 0.002, d: 0.095, s: 0.0006, r: 0.03, lp: [4000, 1200] }));
alias('frog_lay_spawn', 'slime_squish');
alias('frog_eat', 'eat');
S('allay_item_given', 'neutral', 0.7, 0.08, (ctx, dest, o) => {
  let e = o.t;
  for (let i = 0; i < 3; i++) e = Math.max(e, bell(ctx, dest, o, { at: i * 0.07, f: 880 * Math.pow(2, i / 5), dur: 1.0, ratio: 3.2, index: 1.8, gain: 0.15 }));
  return e;
}, { reverb: 0.35 });
alias('allay_item_taken', 'allay_item_given');
alias('allay_item_thrown', 'item_drop');
S('phantom_swoop', 'hostile', 0.8, 0.12, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'white', dur: 0.55, gain: 0.26, a: 0.05, d: 0.42, s: 0.02, bp: [900, 4200], q: 1.2 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 420, f2: 1300, dur: 0.5, gain: 0.14, a: 0.05, d: 0.4, s: 0.01, r: 0.12, lp: [2400, 5200], q: 4 }));
}, { maxDist: 32 });
alias('phantom_screech', 'phantom_idle');
alias('phantom_bite', 'hit_generic');
alias('phantom_flap', 'bat_takeoff');
S('guardian_attack', 'hostile', 0.85, 0.08, (ctx, dest, o) => {
  const g = grit(ctx, dest, 10, 0.85);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 240, f2: 620, dur: 1.4, gain: 0.24, a: 0.3, d: 0.9, s: 0.09, r: 0.35, lp: [1400, 3200], q: 6, vib: [9, 140] });
  return Math.max(e, noise(ctx, g, o, { color: 'sparkle', dur: 1.3, gain: 0.1, a: 0.3, d: 0.9, s: 0.02, r: 0.35, bp: [1800, 3600], q: 1.6 }));
}, { maxDist: 32, reverb: 0.4 });
alias('guardian_flop', 'splash');
alias('elder_guardian_curse', 'guardian_attack');
S('shulker_open', 'hostile', 0.7, 0.12, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'pink', dur: 0.32, gain: 0.24, a: 0.02, d: 0.26, s: 0.006, bp: [800, 2000], q: 2.4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 190, f2: 330, dur: 0.3, gain: 0.12, a: 0.02, d: 0.25, s: 0.005, r: 0.08, lp: [1200, 2000], q: 5 }));
});
S('shulker_close', 'hostile', 0.7, 0.12, (ctx, dest, o) => {
  const e = noise(ctx, dest, o, { color: 'pink', dur: 0.28, gain: 0.24, a: 0.015, d: 0.23, s: 0.005, bp: [2000, 700], q: 2.4 });
  return Math.max(e, tone(ctx, dest, o, { type: 'sawtooth', f: 330, f2: 180, dur: 0.26, gain: 0.12, a: 0.015, d: 0.22, s: 0.004, r: 0.07, lp: [2000, 1000], q: 5 }));
});
alias('shulker_shoot', 'dispenser_fire');
alias('shulker_teleport', 'enderman_teleport');
alias('shulker_bullet_hit', 'arrow_hit');
S('ravager_roar', 'hostile', 1.0, 0.07, (ctx, dest, o) => {
  const g = grit(ctx, dest, 24, 0.9);
  let e = tone(ctx, g, o, { type: 'sawtooth', f: 74, f2: 170, dur: 1.7, gain: 0.38, a: 0.08, d: 1.2, s: 0.12, r: 0.45, lp: [900, 2200], q: 5, vib: [5, 55] });
  e = Math.max(e, tone(ctx, g, o, { type: 'square', f: 148, f2: 340, dur: 1.6, gain: 0.14, a: 0.09, d: 1.15, s: 0.04, r: 0.45, lp: [1400, 2600] }));
  return Math.max(e, noise(ctx, g, o, { color: 'brown', dur: 1.55, gain: 0.16, a: 0.1, d: 1.1, s: 0.025, r: 0.45, bp: [420, 1400], q: 1.2 }));
}, { maxDist: 64, reverb: 0.4 });
alias('ravager_bite', 'hit_generic');
alias('ravager_stun', 'ravager_hurt');
alias('ravager_attack', 'ravager_roar');
alias('ravager_celebrate', 'ravager_roar');
S('evoker_cast_spell', 'hostile', 0.85, 0.08, (ctx, dest, o) => {
  let e = tone(ctx, dest, o, { type: 'sawtooth', f: 130, f2: 520, dur: 0.9, gain: 0.24, a: 0.08, d: 0.7, s: 0.03, r: 0.2, lp: [900, 3200], q: 6, vib: [7, 60] });
  return Math.max(e, noise(ctx, dest, o, { color: 'sparkle', dur: 0.85, gain: 0.12, a: 0.08, d: 0.66, s: 0.012, r: 0.2, bp: [1600, 3800], q: 1.4 }));
}, { reverb: 0.35 });
alias('evoker_prepare_summon', 'evoker_cast_spell');
alias('evoker_prepare_attack', 'evoker_cast_spell');
alias('evoker_prepare_wololo', 'evoker_cast_spell');
alias('evoker_fangs', 'dig_stone');
alias('illusioner_cast_spell', 'evoker_cast_spell');
alias('vex_charge', 'vex_hurt');
alias('piglin_snort', 'piglin_idle');
alias('piglin_admire', 'piglin_idle');
alias('piglin_jealous', 'piglin_angry');
alias('piglin_celebrate', 'piglin_idle');
alias('piglin_converted', 'zombified_piglin_idle');
alias('piglin_retreat', 'piglin_hurt');
alias('hoglin_attack', 'hoglin_angry');
alias('hoglin_retreat', 'hoglin_hurt');
alias('sheep_shear', 'axe_strip');
alias('chicken_egg', 'item_drop');
alias('cow_milk', 'milk');
alias('turtle_egg_crack', 'dig_gravel');
alias('turtle_egg_hatch', 'dig_gravel');
alias('zombie_infect', 'zombie_hurt');
alias('zombie_convert', 'zombie_villager_idle');
alias('zombie_break_door', 'dig_wood');
alias('zombie_attack_door', 'dig_wood');
alias('breeze_shoot', 'arrow_whoosh');
alias('breeze_wind_burst', 'wind');
alias('breeze_slide', 'arrow_whoosh');
alias('creaking_activate', 'creaking_angry');

// ---------------------------------------------------------------------------
// Ambient music
//
// Every track is generated live: a slow evolving pad, sparse bell tones on a
// pentatonic-ish scale and occasional gentle arpeggios, all scheduled a couple
// of seconds ahead by a lookahead pump.
// ---------------------------------------------------------------------------

/** Procedural ambient track definitions. */
export const MUSIC_TRACKS = {
  sweden: { root: 48, scale: 'penta_major', bpm: 50, chords: [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [-1, 2, 7]], pad: 0.075, bell: 0.30, arp: 0.30, length: 165, reverb: 0.5, dim: 'overworld' },
  haggstrom: { root: 46, scale: 'major', bpm: 56, chords: [[0, 5, 9], [2, 7, 11], [-3, 2, 5], [0, 4, 9]], pad: 0.07, bell: 0.34, arp: 0.26, length: 150, reverb: 0.45, dim: 'overworld' },
  mice_on_venus: { root: 50, scale: 'lydian', bpm: 44, chords: [[0, 4, 11], [-2, 5, 9], [3, 7, 10], [-5, 2, 7]], pad: 0.08, bell: 0.26, arp: 0.34, length: 180, reverb: 0.55, dim: 'overworld' },
  wet_hands: { root: 53, scale: 'penta_major', bpm: 62, chords: [[0, 4, 7], [-4, 0, 5], [2, 7, 9], [-2, 3, 7]], pad: 0.055, bell: 0.42, arp: 0.22, length: 140, reverb: 0.4, dim: 'overworld' },
  subwoofer_lullaby: { root: 44, scale: 'aeolian', bpm: 48, chords: [[0, 3, 7], [-2, 5, 8], [3, 7, 10], [-4, 0, 7]], pad: 0.09, bell: 0.24, arp: 0.20, length: 175, reverb: 0.55, dim: 'overworld' },
  dry_hands: { root: 55, scale: 'dorian', bpm: 58, chords: [[0, 3, 7], [-3, 2, 7], [5, 8, 12], [0, 5, 9]], pad: 0.06, bell: 0.36, arp: 0.28, length: 145, reverb: 0.45, dim: 'overworld' },
  concrete_halls: { root: 41, scale: 'phrygian', bpm: 42, chords: [[0, 3, 7], [1, 5, 8], [-2, 3, 6], [0, 4, 7]], pad: 0.10, bell: 0.20, arp: 0.14, length: 190, reverb: 0.6, dim: 'nether' },
  the_end: { root: 47, scale: 'aeolian', bpm: 38, chords: [[0, 3, 10], [-4, 2, 7], [5, 8, 14], [-2, 3, 8]], pad: 0.10, bell: 0.22, arp: 0.16, length: 200, reverb: 0.65, dim: 'end' },
  menu: { root: 52, scale: 'penta_major', bpm: 54, chords: [[0, 4, 7], [-5, 0, 4], [2, 7, 11], [-3, 2, 9]], pad: 0.07, bell: 0.32, arp: 0.24, length: 160, reverb: 0.5, dim: 'menu' },
};
/** Every ambient track name. */
export const MUSIC_NAMES = Object.keys(MUSIC_TRACKS);

const BASE_CAT_GAIN = {
  music: 0.55, blocks: 0.95, hostile: 0.95, neutral: 0.95,
  players: 1.0, ambient: 0.75, weather: 0.8,
};

// ---------------------------------------------------------------------------
// SoundEngine
// ---------------------------------------------------------------------------

/**
 * The procedural audio engine. Construct freely at module scope; call init()
 * from a user gesture before anything will actually make noise.
 */
export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.master = null;
    this.limiter = null;
    this.reverb = null;
    this.cats = Object.create(null);
    this.volumes = { master: 1, music: 0.6, blocks: 1, hostile: 1, neutral: 1, players: 1, ambient: 0.9, weather: 0.9 };
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.voices = [];
    this.active = new Map();
    this.lastPlay = new Map();
    this.maxVoices = 44;
    this.rng = new RNG(0x5eed1e);
    this.music = { playing: false, name: null, nodes: [] };
    this._timer = null;
    this._nextMusicAt = Infinity;
    this._pumpCount = 0;
  }

  /** Creates the AudioContext and audio graph. Must run from a user gesture. */
  init() {
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return true;
      }
      if (typeof window === 'undefined') return false;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -9;
      limiter.knee.value = 8;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.22;
      limiter.connect(ctx.destination);
      this.limiter = limiter;

      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(limiter);
      this.master = master;

      const conv = ctx.createConvolver();
      conv.buffer = reverbIR(ctx, 2.4, 3.0);
      const revOut = ctx.createGain();
      revOut.gain.value = 0.5;
      conv.connect(revOut);
      revOut.connect(master);
      this.reverb = conv;
      this.reverbOut = revOut;

      for (const c of SOUND_CATEGORIES) {
        if (c === 'master') continue;
        const g = ctx.createGain();
        g.gain.value = (BASE_CAT_GAIN[c] == null ? 1 : BASE_CAT_GAIN[c]);
        g.connect(master);
        this.cats[c] = g;
      }

      this.enabled = true;
      this._applySettings();
      try {
        Game.on('settingschange', (k, v) => { if (k === 'volume') this._applySettings(v); });
      } catch (e) { /* event bus not ready - harmless */ }

      this._nextMusicAt = ctx.currentTime + 30 + this.rng.next() * 60;
      if (this._timer == null && typeof setInterval === 'function') {
        this._timer = setInterval(() => this._pump(), 140);
      }
      return true;
    } catch (e) {
      console.warn('[audio] init failed', e);
      this.ctx = null;
      this.enabled = false;
      return false;
    }
  }

  /** Pulls per-category volumes out of Game.settings, if it exists yet. */
  _applySettings(volumes) {
    try {
      const v = volumes || (Game.settings && Game.settings.values && Game.settings.values.volume);
      if (!v) { this.setVolume('master', this.volumes.master); return; }
      for (const k of Object.keys(v)) this.setVolume(k, v[k]);
    } catch (e) { /* ignore */ }
  }

  /** True when nothing recently threatened the player - gates ambient music. */
  _isCalm() {
    try {
      if (Game.paused) return false;
      const p = Game.player;
      if (!p) return true;
      if (p.dead || p.removed) return false;
      if ((p.hurtTime | 0) > 0) return false;
      if (p.health != null && p.maxHealth && p.health < p.maxHealth * 0.55) return false;
      return true;
    } catch (e) { return true; }
  }

  _pickTrack() {
    let dim = 'overworld';
    try { if (Game.dimension) dim = Game.dimension; } catch (e) { /* ignore */ }
    const pool = MUSIC_NAMES.filter((n) => MUSIC_TRACKS[n].dim === dim);
    const list = pool.length ? pool : MUSIC_NAMES;
    return list[this.rng.int(list.length)];
  }

  /** Housekeeping: retires finished voices, feeds the music scheduler. */
  _pump() {
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      this._prune(now);
      this._musicPump(now);
      if (++this._pumpCount % 24 === 0 && !this.music.playing &&
          now >= this._nextMusicAt && this.volumes.music > 0.01 && this._isCalm()) {
        this.startMusic(this._pickTrack());
      }
    } catch (e) { /* never let the timer throw */ }
  }

  /** Optional per-frame hook; the internal timer already covers this. */
  update() { this._pump(); }

  _prune(now) {
    const v = this.voices;
    for (let i = v.length - 1; i >= 0; i--) {
      if (v[i].end > now) continue;
      this._disconnect(v[i]);
      this._unlist(v[i], i);
    }
  }

  /** Drops a voice from both bookkeeping lists. */
  _remove(voice) {
    const i = this.voices.indexOf(voice);
    if (i >= 0) this._unlist(voice, i);
  }

  _unlist(voice, index) {
    this.voices.splice(index, 1);
    const arr = this.active.get(voice.name);
    if (arr) {
      const j = arr.indexOf(voice);
      if (j >= 0) arr.splice(j, 1);
    }
  }

  _disconnect(v) {
    try { v.gain.disconnect(); } catch (e) { /* ignore */ }
    if (v.chain) for (const n of v.chain) { try { n.disconnect(); } catch (e) { /* ignore */ } }
  }

  _killVoice(v, fade) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const f = fade == null ? 0.12 : fade;
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(Math.max(0.0003, v.gain.gain.value), now);
      v.gain.gain.exponentialRampToValueAtTime(0.0003, now + f);
    } catch (e) { /* ignore */ }
    for (const s of v.srcs) { try { s.stop(now + f); } catch (e) { /* ignore */ } }
    v.end = now + f + 0.05;
    // Free the graph once the fade has finished even if _prune already dropped it.
    if (typeof setTimeout === 'function') setTimeout(() => this._disconnect(v), (f + 0.2) * 1000);
  }

  /**
   * Plays a sound. `opts` accepts { volume, pitch, x, y, z }; supplying
   * coordinates makes it positional. No-ops until init() has run.
   * @returns {object|null} the voice handle, or null if nothing played
   */
  play(name, opts) {
    try {
      if (!this.ctx || !this.enabled) return null;
      const ctx = this.ctx;
      if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return null; }
      const def = resolve(name);
      if (!def) return null;
      const o = opts || {};
      const now = ctx.currentTime;
      const last = this.lastPlay.get(def.name);
      if (last != null && now - last < def.cooldown) return null;

      let vol = (o.volume == null ? 1 : o.volume) * def.volume;
      if (vol <= 0) return null;
      let pitch = o.pitch == null ? 1 : o.pitch;
      if (def.pitchVariance) pitch *= 1 + (this.rng.next() * 2 - 1) * def.pitchVariance;
      pitch = clamp(pitch, 0.25, 4);

      let pan = 0;
      let dist = 0;
      const positional = Number.isFinite(o.x) && Number.isFinite(o.z);
      if (positional) {
        const L = this.listener;
        const dx = o.x - L.x;
        const dy = (Number.isFinite(o.y) ? o.y : L.y) - L.y;
        const dz = o.z - L.z;
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const maxD = def.maxDist * Math.max(1, vol);
        if (dist > maxD) return null;
        const att = 1 - dist / maxD;
        vol *= att * att;
        if (vol < 0.004) return null;
        if (dist > 0.4) {
          const rx = -Math.cos(L.yaw), rz = -Math.sin(L.yaw);
          pan = clamp((dx * rx + dz * rz) / dist, -1, 1) * 0.85;
        }
      }
      this.lastPlay.set(def.name, now);

      // Retire finished and then oldest disposable voices when we hit the cap.
      // Done inline rather than waiting for the timer so a burst of sounds in a
      // single frame cannot blow past maxVoices.
      if (this.voices.length >= this.maxVoices) {
        this._prune(now);
        while (this.voices.length >= this.maxVoices) {
          let oldest = null;
          for (const v of this.voices) if (!v.loop && (!oldest || v.start < oldest.start)) oldest = v;
          if (!oldest) return null;
          this._killVoice(oldest, 0.03);
          this._remove(oldest);
        }
      }

      const catGain = this.cats[def.category] || this.cats.blocks || this.master;
      const vg = ctx.createGain();
      vg.gain.value = vol;
      const chain = [];
      let node = vg;
      if (positional && dist > 6) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = clamp(20000 * Math.pow(0.55, (dist - 6) / 10), 700, 20000);
        node.connect(lp);
        node = lp;
        chain.push(lp);
      }
      if (typeof ctx.createStereoPanner === 'function') {
        const sp = ctx.createStereoPanner();
        sp.pan.value = pan;
        node.connect(sp);
        node = sp;
        chain.push(sp);
      }
      node.connect(catGain);
      if (def.reverb > 0 && this.reverb) {
        const send = ctx.createGain();
        send.gain.value = def.reverb * vol;
        node.connect(send);
        send.connect(this.reverb);
        chain.push(send);
      }

      const t = now + 0.012;
      const so = { t, pitch, rng: this.rng, srcs: [], loop: def.loop, volume: vol, engine: this, opts: o };
      let dur = 0.5;
      try {
        const r = def.synth(ctx, vg, so);
        if (typeof r === 'number' && isFinite(r)) dur = Math.max(0.05, r - t);
        else if (r && typeof r.dur === 'number' && isFinite(r.dur)) dur = Math.max(0.05, r.dur);
      } catch (e) {
        console.warn('[audio] synth failed for ' + def.name, e);
      }

      const voice = {
        name: def.name, def, gain: vg, chain, srcs: so.srcs, loop: def.loop,
        start: now, end: def.loop ? Infinity : t + dur + 0.25,
      };
      this.voices.push(voice);
      let arr = this.active.get(def.name);
      if (!arr) { arr = []; this.active.set(def.name, arr); }
      arr.push(voice);
      return voice;
    } catch (e) {
      return null;
    }
  }

  /** Positional convenience wrapper. */
  playAt(name, x, y, z, volume, pitch) {
    return this.play(name, { x, y, z, volume: volume == null ? 1 : volume, pitch: pitch == null ? 1 : pitch });
  }

  /** Fades out and releases every live instance of a sound. */
  stop(name) {
    try {
      if (!this.ctx) return;
      const def = resolve(name);
      const key = def ? def.name : name;
      const arr = this.active.get(key);
      if (!arr || !arr.length) return;
      for (const v of arr.slice()) this._killVoice(v, 0.15);
    } catch (e) { /* ignore */ }
  }

  /** Stops everything, music included. */
  stopAll() {
    try {
      for (const v of this.voices.slice()) this._killVoice(v, 0.08);
      this.stopMusic(0.4);
    } catch (e) { /* ignore */ }
  }

  /** Updates the listener transform used for panning and attenuation. */
  setListener(x, y, z, yaw) {
    if (Number.isFinite(x)) this.listener.x = x;
    if (Number.isFinite(y)) this.listener.y = y;
    if (Number.isFinite(z)) this.listener.z = z;
    if (Number.isFinite(yaw)) this.listener.yaw = yaw;
  }

  /** Sets a category volume in 0..1 ('master' scales everything). */
  setVolume(category, v) {
    try {
      const val = clamp(Number(v), 0, 1) || 0;
      if (category === 'master') {
        this.volumes.master = val;
        if (this.master) this.master.gain.value = val * val;
        return;
      }
      if (!(category in this.volumes) && !this.cats[category]) return;
      this.volumes[category] = val;
      const g = this.cats[category];
      if (g) g.gain.value = val * val * (BASE_CAT_GAIN[category] == null ? 1 : BASE_CAT_GAIN[category]);
    } catch (e) { /* ignore */ }
  }

  /** Current 0..1 volume for a category. */
  getVolume(category) { return this.volumes[category] == null ? 1 : this.volumes[category]; }

  /** True once the context exists and is running. */
  get ready() { return !!(this.ctx && this.enabled && this.ctx.state !== 'suspended'); }
  /** Live voice count, for the debug overlay. */
  get voiceCount() { return this.voices.length; }
  /** Name of the ambient track currently playing, or null. */
  get currentMusic() { return this.music.playing ? this.music.name : null; }

  // ---- music ---------------------------------------------------------------

  /** Starts an ambient track (random when `track` is missing or unknown). */
  startMusic(track) {
    try {
      if (!this.ctx || !this.enabled) return false;
      if (this.music.playing) this.stopMusic(0.8);
      const name = (track && MUSIC_TRACKS[track]) ? track : this._pickTrack();
      const d = MUSIC_TRACKS[name];
      const ctx = this.ctx;
      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(this.cats.music || this.master);
      const send = ctx.createGain();
      send.gain.value = d.reverb == null ? 0.4 : d.reverb;
      bus.connect(send);
      if (this.reverb) send.connect(this.reverb);
      const now = ctx.currentTime;
      this.music = {
        playing: true, name, def: d, bus, send, nodes: [], step: 0,
        stepDur: 60 / d.bpm / 2, nextTime: now + 0.5,
        endTime: now + (d.length || 150),
        chordIdx: this.rng.int(d.chords.length),
        rng: new RNG(hashString(name) ^ ((this.rng.next() * 0xffffffff) >>> 0)),
      };
      return true;
    } catch (e) { return false; }
  }

  /** Fades out the ambient track and schedules the next one. */
  stopMusic(fade) {
    try {
      const m = this.music;
      if (!m || !m.playing || !this.ctx) { if (m) m.playing = false; return; }
      const now = this.ctx.currentTime;
      const f = fade == null ? 1.6 : fade;
      m.playing = false;
      if (m.bus) {
        try {
          m.bus.gain.cancelScheduledValues(now);
          m.bus.gain.setValueAtTime(Math.max(0.0003, m.bus.gain.value), now);
          m.bus.gain.exponentialRampToValueAtTime(0.0003, now + f);
        } catch (e) { /* ignore */ }
      }
      for (const e of m.nodes) { try { e.n.stop(now + f + 0.05); } catch (err) { /* ignore */ } }
      const bus = m.bus, send = m.send;
      if (typeof setTimeout === 'function') {
        setTimeout(() => {
          try { if (bus) bus.disconnect(); } catch (e) { /* ignore */ }
          try { if (send) send.disconnect(); } catch (e) { /* ignore */ }
        }, (f + 0.5) * 1000);
      }
      this._nextMusicAt = now + 150 + this.rng.next() * 300;
      this.music = { playing: false, name: null, nodes: [] };
    } catch (e) { /* ignore */ }
  }

  _musicPump(now) {
    const m = this.music;
    if (!m.playing) return;
    if (m.endTime && now > m.endTime) { this.stopMusic(); return; }
    const ahead = now + 2.0;
    let guard = 0;
    while (m.nextTime < ahead && guard++ < 64) {
      this._musicStep(m, m.nextTime);
      m.nextTime += m.stepDur;
      m.step++;
    }
    if (m.nodes.length > 260) {
      m.nodes = m.nodes.filter((e) => e.until > now);
    }
  }

  _musicStep(m, t) {
    const d = m.def, rng = m.rng, sd = m.stepDur;
    const scale = SCALES[d.scale] || SCALES.penta_major;
    if (m.step % 16 === 0) {
      m.chordIdx = (m.chordIdx + 1 + (rng.next() < 0.3 ? 1 : 0)) % d.chords.length;
      this._pad(m, t, d.chords[m.chordIdx].map((s) => NOTE(d.root + s)), d.pad, sd * 16.6);
    }
    const chord = d.chords[m.chordIdx];
    if (m.step % 8 === 0) this._bass(m, t, NOTE(d.root - 12 + chord[0]), sd * 6);
    if (rng.next() < d.bell) {
      const oct = 12 * (rng.next() < 0.35 ? 3 : 2);
      const f = NOTE(d.root + oct + scale[rng.int(scale.length)]);
      this._bellNote(m, t + rng.next() * sd * 0.25, f, 0.13 + rng.next() * 0.05, 1.8 + rng.next() * 2.2);
    }
    if (m.step % 8 === 4 && rng.next() < d.arp) {
      const n = 3 + rng.int(3);
      let deg = rng.int(scale.length);
      for (let i = 0; i < n; i++) {
        this._arpNote(m, t + i * sd * 0.5, degFreq(d.root + 24, scale, deg), 0.075);
        deg += 1 + (rng.next() < 0.3 ? 1 : 0);
      }
    }
  }

  _track(m, node, until) { m.nodes.push({ n: node, until }); }

  _pad(m, t, freqs, level, dur) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(480, t);
    lp.frequency.linearRampToValueAtTime(1700, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(560, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0003, t);
    g.gain.linearRampToValueAtTime(level, t + dur * 0.4);
    g.gain.setValueAtTime(level, t + dur * 0.62);
    g.gain.linearRampToValueAtTime(0.0003, t + dur);
    lp.connect(g);
    g.connect(m.bus);
    for (const f of freqs) {
      for (const det of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = clamp(f, 20, 8000);
        osc.detune.value = det;
        osc.connect(lp);
        osc.start(t);
        osc.stop(t + dur + 0.15);
        this._track(m, osc, t + dur + 0.2);
      }
    }
  }

  _bass(m, t, f, dur) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = clamp(f, 20, 400);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0003, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0003, t + dur);
    osc.connect(g);
    g.connect(m.bus);
    osc.start(t);
    osc.stop(t + dur + 0.1);
    this._track(m, osc, t + dur + 0.15);
  }

  _bellNote(m, t, f, level, dur) {
    const ctx = this.ctx;
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = clamp(f, 30, 8000);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = clamp(f * 2.01, 30, 16000);
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * 1.4, t);
    mg.gain.exponentialRampToValueAtTime(Math.max(0.01, f * 0.02), t + dur * 0.5);
    mod.connect(mg);
    mg.connect(car.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0003, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0003, t + dur);
    car.connect(g);
    g.connect(m.bus);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.1); mod.stop(t + dur + 0.1);
    this._track(m, car, t + dur + 0.15);
    this._track(m, mod, t + dur + 0.15);
  }

  _arpNote(m, t, f, level) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = clamp(f, 30, 9000);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(f * 4, 200, 12000);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0003, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0003, t + 0.9);
    osc.connect(lp); lp.connect(g); g.connect(m.bus);
    osc.start(t);
    osc.stop(t + 1.0);
    this._track(m, osc, t + 1.05);
  }

  /** Releases the AudioContext. */
  dispose() {
    try {
      this.stopAll();
      if (this._timer != null && typeof clearInterval === 'function') clearInterval(this._timer);
      this._timer = null;
      if (this.ctx && typeof this.ctx.close === 'function') this.ctx.close().catch(() => {});
    } catch (e) { /* ignore */ }
    this.ctx = null;
    this.enabled = false;
  }
}

/** Shared engine instance, for modules that do not receive one explicitly. */
export const Sound = new SoundEngine();
export default SoundEngine;
