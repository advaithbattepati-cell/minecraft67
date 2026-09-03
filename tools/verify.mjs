#!/usr/bin/env node
// Boots the game in headless Chromium and reports console errors, boot failures,
// runtime state and a screenshot. This is the project's integration test.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8099);
const SHOTS = path.join(ROOT, 'tools', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const PLAY_SECONDS = Number((args.find((a) => a.startsWith('--seconds=')) || '--seconds=25').split('=')[1]);

const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.js')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
});
const stopServer = () => { try { server.kill('SIGKILL'); } catch {} };
process.on('exit', stopServer);

await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
         '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const warnings = [];
const logs = [];
page.on('console', (m) => {
  const t = m.type();
  const text = m.text();
  if (t === 'error') errors.push(text);
  else if (t === 'warning') warnings.push(text);
  else logs.push(`${t}: ${text}`);
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + (e.stack || e.message)));
page.on('requestfailed', (r) => errors.push(`REQUESTFAILED: ${r.url()} ${r.failure()?.errorText}`));

const result = { ok: false, stage: 'start', errors, warnings, notes: [] };

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  result.stage = 'loaded';

  // Wait for boot.
  await page.waitForFunction('window.__gameReady === true || window.__bootError', { timeout: 90000 })
    .catch(() => { result.notes.push('timed out waiting for __gameReady'); });

  const bootError = await page.evaluate('window.__bootError || null');
  if (bootError) { result.bootError = bootError; }
  result.gameReady = await page.evaluate('window.__gameReady === true');
  result.stage = 'booted';

  await page.screenshot({ path: path.join(SHOTS, '01-boot.png') });

  // Start a world through the test hook if present.
  const started = await page.evaluate(`(async () => {
    if (window.__mc && typeof window.__mc.quickStart === 'function') { await window.__mc.quickStart(); return 'hook'; }
    return 'none';
  })()`).catch((e) => 'error: ' + e.message);
  result.startMethod = started;

  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(SHOTS, '02-world.png') });

  // Let it simulate.
  const t0 = Date.now();
  while (Date.now() - t0 < PLAY_SECONDS * 1000) {
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: path.join(SHOTS, '03-playing.png') });
  result.stage = 'played';

  result.state = await page.evaluate(`(() => {
    const g = window.Game; if (!g) return { noGame: true };
    const p = g.player;
    return {
      running: g.running, paused: g.paused, mode: g.mode, ticks: g.ticks,
      dimension: g.dimension,
      stats: g.stats,
      player: p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
                    health: p.health, hunger: p.hunger, onGround: p.onGround } : null,
      chunks: g.world ? g.world.chunks.size : 0,
      entities: g.world ? g.world.entities.length : 0,
      registries: window.__mc ? window.__mc.counts && window.__mc.counts() : null,
    };
  })()`).catch((e) => ({ evalError: String(e) }));

  result.ok = result.gameReady === true && errors.length === 0;
} catch (e) {
  result.fatal = String(e && e.stack || e);
}

if (!KEEP) { await browser.close(); stopServer(); }

// Trim noisy duplicates.
const uniq = (a) => [...new Set(a)];
result.errors = uniq(result.errors).slice(0, 40);
result.warnings = uniq(result.warnings).slice(0, 20);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
