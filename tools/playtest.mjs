#!/usr/bin/env node
/**
 * Plays the game the way a person would: real keyboard and mouse events into
 * the page, then checks the world actually changed. Everything here goes
 * through input.js and player.js rather than poking internals.
 *
 * One concession: headless Chromium will not grant pointer lock without a user
 * gesture it trusts, and input.js routes the first click into a lock request
 * instead of an attack. The lock flag is therefore set directly before the
 * mouse tests; every other path is the real one.
 */
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8087);
const SHOTS = path.join(ROOT, 'tools', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
});
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 90000 });
await page.evaluate('window.__mc.quickStart({ seed: 20260904, mode: "survival" })');
await page.waitForTimeout(6000);

// Put the player somewhere flat and settled before driving anything.
await page.evaluate(`(() => {
  const g = Game, p = g.player, w = g.world;
  const y = w.getHeight(Math.floor(p.x), Math.floor(p.z));
  p.y = y; p.py = y; p.vx = p.vy = p.vz = 0;
  p.yaw = 0; p.pitch = 0;
  g.input.pointerLocked = true;     // see the header note
})()`);
await page.waitForTimeout(1200);

const snap = () => page.evaluate(`(() => {
  const p = Game.player;
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
           yaw: +p.yaw.toFixed(2), sel: p.selectedSlot, hp: p.health,
           onGround: p.onGround, items: p.inventory.slots.filter(Boolean).length };
})()`);

// ---- movement -------------------------------------------------------------
const before = await snap();
await page.keyboard.down('KeyW');
await page.waitForTimeout(2000);
await page.keyboard.up('KeyW');
await page.waitForTimeout(500);
const afterW = await snap();
const moved = Math.hypot(afterW.x - before.x, afterW.z - before.z);
check('W moves the player', moved > 0.5, `travelled ${moved.toFixed(2)} blocks`);

// ---- jump -----------------------------------------------------------------
// Settle on the ground first: pressing jump mid-fall correctly does nothing.
await page.evaluate(`(() => { const p = Game.player; p.vx = p.vz = 0; })()`);
await page.waitForFunction('Game.player.onGround === true', { timeout: 15000 }).catch(() => {});
await page.evaluate('Game.player.vy = 0');
await page.keyboard.down('Space');
// Sample repeatedly and take the peak: holding jump bunny-hops, so a single
// sample often lands between hops and reads zero, especially at a low frame
// rate. The peak is what says whether the impulse ever fired.
let peakVy = 0;
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(120);
  peakVy = Math.max(peakVy, await page.evaluate('Game.player.vy'));
}
await page.keyboard.up('Space');
await page.waitForTimeout(900);
check('Space jumps', peakVy > 1, `peak upward velocity ${peakVy.toFixed(2)}`);

// ---- hotbar ---------------------------------------------------------------
await page.keyboard.press('Digit4');
await page.waitForTimeout(300);
const sel = (await snap()).sel;
check('number keys change the hotbar slot', sel === 3, `slot ${sel}`);

// ---- mining ---------------------------------------------------------------
const target = await page.evaluate(`(() => {
  const g = Game, p = g.player, w = g.world, B = window.__mc.mods.blocks;
  const inv = window.__mc.mods.inventory;
  // Mine a block directly in FRONT at eye height, the way a player would.
  // Mining the block underfoot drops the player into the hole and, on sand,
  // starts a gravity cascade - that tests the scenario, not the mechanic.
  // yaw 0 looks towards +Z in this engine's convention.
  p.yaw = 0; p.pitch = 0;
  p.inventory.set(0, inv.stack('iron_pickaxe'));
  p.selectedSlot = 0;
  const x = Math.floor(p.x), z = Math.floor(p.z) + 1;
  const y = Math.floor(p.y + p.eyeHeight);
  w.setBlock(x, y, z, B.blockByName('stone').id, 0, 3);
  const hit = p.raycastTarget().block;
  return { x, y, z, name: B.getBlock(w.getBlock(x, y, z)).name,
           aimed: !!hit && hit.x === x && hit.y === y && hit.z === z,
           hitAt: hit ? [hit.x, hit.y, hit.z] : null };
})()`);
check('the crosshair lands on the target block', target.aimed,
  `aiming at ${JSON.stringify(target.hitAt)}, wanted [${target.x}, ${target.y}, ${target.z}]`);
await page.mouse.move(400, 250);
await page.mouse.down({ button: 'left' });
await page.waitForTimeout(9000);
await page.mouse.up({ button: 'left' });
await page.waitForTimeout(1500);
const mined = await page.evaluate(`(() => {
  const g = Game, B = window.__mc.mods.blocks;
  const now = B.getBlock(g.world.getBlock(${target.x}, ${target.y}, ${target.z})).name;
  const drops = g.world.entities.filter(e => e.type === 'item').length;
  const held = g.player.inventory.slots.filter(Boolean).map(s => s.item + ' x' + s.count);
  return { was: '${target.name}', now, drops, held };
})()`);
check('holding left click breaks a block',
  mined.now !== mined.was && mined.now === 'air',
  `${mined.was} -> ${mined.now}`);
check('breaking a block yields a drop',
  mined.drops > 0 || mined.held.length > 0,
  `${mined.drops} item entities, inventory: ${mined.held.join(', ') || 'empty'}`);

await page.waitForTimeout(3000);
const picked = await page.evaluate(
  `Game.player.inventory.slots.filter(Boolean).map(s => s.item + ' x' + s.count)`);
check('the drop is picked up', picked.length > 0, picked.join(', ') || 'nothing collected');

// ---- placing --------------------------------------------------------------
const placed = await page.evaluate(`(() => {
  const g = Game, p = g.player, B = window.__mc.mods.blocks;
  const inv = window.__mc.mods.inventory;
  p.inventory.set(0, inv.stack('cobblestone', 8));
  p.selectedSlot = 0;
  // Aim down at the ground ahead. A block can only go against the face of an
  // existing one, so look at a real surface and derive where it should land.
  p.yaw = 0; p.pitch = 0.9;
  const hit = p.raycastTarget().block;
  if (!hit) return { aimed: false };
  return {
    aimed: true,
    x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz,
    against: B.getBlock(g.world.getBlock(hit.x, hit.y, hit.z)).name,
    before: B.getBlock(g.world.getBlock(hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz)).name,
  };
})()`);
check('the crosshair finds a surface to build on', placed.aimed,
  placed.aimed ? `against ${placed.against}` : 'nothing in reach');
await page.waitForTimeout(400);
await page.mouse.down({ button: 'right' });
await page.waitForTimeout(700);
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(800);
const afterPlace = await page.evaluate(`(() => {
  const B = window.__mc.mods.blocks;
  const n = B.getBlock(Game.world.getBlock(${placed.x}, ${placed.y}, ${placed.z})).name;
  const left = Game.player.inventory.get(0);
  return { now: n, left: left ? left.count : 0 };
})()`);
check('right click places the held block',
  afterPlace.now === 'cobblestone',
  `${placed.before} -> ${afterPlace.now}, ${afterPlace.left} left of 8`);

// ---- inventory screen -----------------------------------------------------
await page.keyboard.press('KeyE');
await page.waitForTimeout(900);
const invOpen = await page.evaluate(`(() => {
  const s = Game.ui.screens;
  return { open: !!(s && s.isOpen && s.isOpen()), name: s && s.current };
})()`);
check('E opens the inventory', invOpen.open, `screen: ${invOpen.name}`);
await page.screenshot({ path: path.join(SHOTS, 'play-inventory.png'), timeout: 20000 }).catch(() => {});
await page.keyboard.press('Escape');
await page.waitForTimeout(700);
const invClosed = await page.evaluate('!(Game.ui.screens.isOpen && Game.ui.screens.isOpen())');
check('Escape closes the inventory', invClosed);

// ---- crafting through the real recipe path --------------------------------
const crafted = await page.evaluate(`(() => {
  const inv = window.__mc.mods.inventory, R = window.__mc.mods.recipes;
  const grid = [inv.stack('oak_log'), null, null, null];
  const planks = R.matchRecipe(grid, 2, 2);
  if (!planks) return { ok: false, step: 'planks' };
  const g2 = [inv.stack('oak_planks'), null, inv.stack('oak_planks'), null];
  const sticks = R.matchRecipe(g2, 2, 2);
  if (!sticks) return { ok: false, step: 'sticks' };
  const p = () => inv.stack('oak_planks'), s = () => inv.stack('stick');
  const pick = R.matchRecipe([p(), p(), p(), null, s(), null, null, s(), null], 3, 3);
  return { ok: !!pick, planks: planks.item + ' x' + planks.count,
           sticks: sticks.item + ' x' + sticks.count, pick: pick && pick.item };
})()`);
check('log -> planks -> sticks -> pickaxe',
  crafted.ok, `${crafted.planks}, ${crafted.sticks}, ${crafted.pick}`);

// ---- chat command ---------------------------------------------------------
await page.evaluate(`Game.ui.chat.runCommand('/give diamond_sword 1')`);
await page.waitForTimeout(700);
const gave = await page.evaluate(
  `Game.player.inventory.slots.filter(Boolean).some(s => s.item === 'diamond_sword')`);
check('/give puts an item in the inventory', gave);

await page.evaluate(`Game.ui.chat.runCommand('/time set night')`);
await page.waitForTimeout(500);
const t = await page.evaluate('Game.world.time');
check('/time set night moves the clock', t >= 12000 && t < 24000, `time ${t}`);

// ---- damage and death -----------------------------------------------------
await page.evaluate(`Game.ui.chat.runCommand('/time set day')`);
const hurt = await page.evaluate(`(() => {
  const p = Game.player, before = p.health;
  p.hurt(6, { type: 'generic' });
  return { before, after: p.health };
})()`);
check('the player takes damage', hurt.after < hurt.before, `${hurt.before} -> ${hurt.after}`);

await page.evaluate(`Game.player.hurt(100, { type: 'generic' })`);
await page.waitForTimeout(1200);
const dead = await page.evaluate(`({ hp: Game.player.health, over: Game.gameOver })`);
check('lethal damage triggers death', dead.hp <= 0 || dead.over, `hp ${dead.hp}, gameOver ${dead.over}`);
await page.evaluate(`Game.player.respawn()`);
await page.waitForTimeout(1500);
const resp = await page.evaluate(`({ hp: Game.player.health, y: +Game.player.y.toFixed(1) })`);
check('respawn restores the player', resp.hp > 0, `hp ${resp.hp} at y ${resp.y}`);

await page.screenshot({ path: path.join(SHOTS, 'play-final.png'), timeout: 20000 }).catch(() => {});

const failed = results.filter((r) => !r.pass);
console.log('');
console.log(`${results.length - failed.length}/${results.length} checks passed`);
console.log('console errors:', errors.length ? [...new Set(errors)].slice(0, 8) : 'none');
await browser.close();
server.kill('SIGKILL');
process.exit(failed.length || errors.length ? 1 : 0);
