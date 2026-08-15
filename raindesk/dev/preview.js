'use strict';

/**
 * One-command Raindesk visual preview.
 *
 * Starts the deterministic mock server on an isolated temporary data dir,
 * waits until the real app is reachable, then asks a locally installed
 * Chromium/Chrome to capture the two acceptance viewports.
 *
 *   node dev/preview.js
 *   RAINDESK_CHROMIUM=/path/to/chromium node dev/preview.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'artifacts', 'preview');
const PORT = Number(process.env.RAINDESK_PREVIEW_PORT || 17601);
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}/`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(120);
  }
  throw new Error(`preview server did not become ready: ${lastError ? lastError.message : 'timeout'}`);
}

function findChromium() {
  if (process.env.RAINDESK_CHROMIUM) return process.env.RAINDESK_CHROMIUM;
  const candidates = [
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
  ];
  for (const name of candidates) {
    const hit = spawnSync('which', [name], { encoding: 'utf8' });
    if (hit.status === 0 && hit.stdout.trim()) return hit.stdout.trim();
  }
  throw new Error(
    'Chromium/Chrome not found. Install chromium or set RAINDESK_CHROMIUM=/path/to/browser.',
  );
}

function capture(browser, name, width, height) {
  const output = path.join(OUTPUT_DIR, `${name}.png`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=1800',
      `--window-size=${width},${height}`,
      `--screenshot=${output}`,
      URL,
    ];
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(output)) {
        reject(new Error(`browser capture ${name} failed (${code}): ${stderr.slice(-800)}`));
        return;
      }
      resolve(output);
    });
  });
}

async function main() {
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    throw new Error('RAINDESK_PREVIEW_PORT must be a valid TCP port');
  }

  const browser = findChromium();
  const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-preview-'));
  const server = spawn(process.execPath, [path.join(__dirname, 'mock-server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RAINDESK_HOST: HOST,
      RAINDESK_PORT: String(PORT),
      RAINDESK_DATA_DIR: tempData,
      RAINDESK_MOCK_DELAY_MS: process.env.RAINDESK_MOCK_DELAY_MS || '80',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverStderr = '';
  server.stderr.on('data', (chunk) => { serverStderr += String(chunk); });

  try {
    await waitForServer(`${URL}api/board`);
    const desktop = await capture(browser, 'desktop-1440x900', 1440, 900);
    const mobile = await capture(browser, 'mobile-390x844', 390, 844);
    // eslint-disable-next-line no-console
    console.log('[raindesk:preview] ready');
    // eslint-disable-next-line no-console
    console.log(`  desktop: ${desktop}`);
    // eslint-disable-next-line no-console
    console.log(`  mobile:  ${mobile}`);
  } finally {
    if (!server.killed) server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('close', resolve)),
      sleep(1000),
    ]);
    if (!server.killed) server.kill('SIGKILL');
    fs.rmSync(tempData, { recursive: true, force: true });
  }

  if (server.exitCode && server.exitCode !== 0) {
    throw new Error(`mock server exited ${server.exitCode}: ${serverStderr.slice(-800)}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[raindesk:preview]', err.message);
    process.exit(1);
  });
}

module.exports = { findChromium, waitForServer, capture };
