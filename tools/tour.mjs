#!/usr/bin/env node
// Flies the camera to a set of vantage points and screenshots each one, so the
// look of the game can be judged without a human at the keyboard.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8098);
const SHOTS = path.join(ROOT, 'tools', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const arg = (n, d) => { const a = process.argv.find((s) => s.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d; };
const SEED = Number(arg('seed', 12345));

const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true || window.__bootError', { timeout: 90000 });
await page.evaluate(`window.__mc.quickStart({ seed: ${SEED} })`);
await page.waitForTimeout(4000);

// Where did we actually land?
const spawnInfo = await page.evaluate(`(() => {
  const g = window.Game, p = g.player, w = g.world;
  const at = (dy) => { const b = w.getBlock(Math.floor(p.x), Math.floor(p.y + dy), Math.floor(p.z)); return window.__mc.mods.blocks.getBlock(b).name; };
  return { x: p.x, y: p.y, z: p.z, feet: at(0), head: at(1.6), below: at(-1), above: at(2.5),
           biome: (window.__mc.mods.biomes.getBiome(w.getBiome(Math.floor(p.x), Math.floor(p.z))) || {}).name };
})()`);
console.log('spawn:', JSON.stringify(spawnInfo));

/** Teleports the player, points the camera, waits for chunks, screenshots. */
async function shot(name, { x, y, z, yaw, pitch, wait = 6000, time = null, dim = null }) {
  await page.evaluate(`(async () => {
    const g = window.Game, p = g.player;
    ${dim ? `if (g.worlds['${dim}'] && g.world !== g.worlds['${dim}']) window.__mc.switchDimension('${dim}');` : ''}
    p.x = ${x}; p.y = ${y}; p.z = ${z}; p.vx = p.vy = p.vz = 0;
    p.px = p.x; p.py = p.y; p.pz = p.z;
    p.yaw = ${yaw}; p.pitch = ${pitch};
    p.noClip = true; p.gravity = false; p.flying = true;
    if (g.world.onEntityMoved) g.world.onEntityMoved(p);
    ${time != null ? `g.world.time = ${time};` : ''}
  })()`);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const st = await page.evaluate('({fps: Game.stats.fps, rendered: Game.stats.chunksRendered, queued: Game.stats.chunksQueued, tris: Game.stats.triangles})');
  console.log(name, JSON.stringify(st));
}

const sx = spawnInfo.x, sz = spawnInfo.z;
await shot('t1-overview',   { x: sx, y: 95,  z: sz - 40, yaw: 0, pitch: -0.35, time: 6000, wait: 9000 });
await shot('t2-ground',     { x: sx, y: spawnInfo.y + 1, z: sz, yaw: 0.8, pitch: -0.05, time: 6000 });
await shot('t3-night',      { x: sx, y: 90, z: sz - 30, yaw: 0, pitch: -0.3, time: 18000, wait: 7000 });
await shot('t4-underwater', { x: sx, y: 50, z: sz, yaw: 0.5, pitch: 0, time: 6000 });
await shot('t5-caves',      { x: sx, y: 20, z: sz, yaw: 0.5, pitch: 0, time: 6000 });
await shot('t6-nether',     { x: 0, y: 70, z: 0, yaw: 0.5, pitch: -0.1, dim: 'nether', wait: 9000 });
await shot('t7-end',        { x: 0, y: 75, z: 0, yaw: 0.5, pitch: -0.15, dim: 'end', wait: 9000 });

// UI screens
await page.evaluate(`(() => { window.__mc.switchDimension('overworld'); Game.ui.screens.open('inventory'); })()`);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(SHOTS, 't8-inventory.png') });
await page.evaluate(`(() => { Game.ui.screens.close(); Game.mode='creative'; if(Game.player) Game.player.gameMode='creative'; Game.ui.screens.open('creative'); })()`);
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(SHOTS, 't9-creative.png') });
await page.evaluate(`(() => { Game.ui.screens.close(); Game.ui.menu.showTitle(); })()`);
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(SHOTS, 't10-title.png') });

console.log('errors:', errors.length ? [...new Set(errors)].slice(0, 10) : 'none');
await browser.close();
server.kill('SIGKILL');
