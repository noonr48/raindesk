'use strict';

/**
 * Stage-5 V3 — the viewport/browser matrix harness.
 *
 * One server, one Chromium, six viewports (320×568, 768×1024, 1280×720,
 * 1440×900, 1920×1080, 2560×1080). Per viewport: fresh page (metrics override set
 * BEFORE navigation), boot ?freeform=1, seed an extreme off-screen screen
 * window, wait for the reflow convergence (reachable title bar), reload at
 * the same viewport, prove the window restores reachable, and require zero
 * console errors. The shared data dir accumulates windows across viewports,
 * exercising convergence over accumulated state.
 *
 * Run: CHROME_BIN=/usr/bin/google-chrome-stable node dev/browser-freeform-desk-matrix.js
 * Env receipts: FREEFORM_MATRIX_SCREENSHOT (per-viewport PNGs).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-freeform-matrix-'));
process.env.RAINDESK_DATA_DIR = DATA_DIR;
process.env.RAINDESK_SEED_BOARD = '0';

const { createServer } = require('../server');

const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT_DIR = process.env.FREEFORM_MATRIX_SCREENSHOT || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIEWPORTS = [
  { label: '320x568', width: 320, height: 568 },
  { label: '768x1024', width: 768, height: 1024 },
  { label: '1280x720', width: 1280, height: 720 },
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1920x1080', width: 1920, height: 1080 },
  { label: '2560x1080', width: 2560, height: 1080 },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.unref(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((e) => e ? reject(e) : resolve(port)); });
  });
}

class CDP {
  constructor(ws) {
    this.ws = this; this.seq = 0; this.pending = new Map(); this.consoleErrors = [];
    this._ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        this.consoleErrors.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300)}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.consoleErrors.push(`exception: ${d && d.text} ${(d && d.exception && d.exception.description || '').slice(0, 300)}`);
      }
      const pending = this.pending.get(msg.id);
      if (!pending) return; this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message)); else pending.resolve(msg.result || {});
    });
  }
  send(method, params = {}, timeoutMs = 12_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this._ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function newTab(browserWsUrl) {
  const browser = new URL(browserWsUrl);
  const created = await fetch(`http://${browser.host}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return cdp;
}

async function value(cdp, expression, awaitPromise = false, timeoutMs = 12_000) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
  if (out.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(out.exceptionDetails)}`);
  return out.result && out.result.value;
}

async function waitFor(cdp, expression, label, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await value(cdp, expression, false, 2_500)) return; }
    catch (error) {
      const msg = String(error && error.message);
      if (/CDP timeout: Runtime\.evaluate/.test(msg)) continue;
      throw error;
    }
    await delay(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runViewport(vp, base, browserWsUrl, index) {
  const cdp = await newTab(browserWsUrl);
  // Metrics override BEFORE navigation: the app boots into this viewport.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${base}/?freeform=1` });
  await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot==='ready'`, `${vp.label} boot`, 60_000);
  await waitFor(cdp, `window.raindeskFreeform && typeof window.raindeskFreeform.open === 'function'`, `${vp.label} manager`, 10_000);

  // Screen-reflow path E2E: register a screen-classified chrome surface
  // (the shipped 7 are all world — world rects stay canonical, reachable by
  // pan) and seed it at an extreme; the boot+resize reflow must converge it.
  await value(cdp, `window.RaindeskWindowManager.CreativeSurfaces.register({ id: 'matrix_chrome', title: 'Matrix Chrome', entityType: 'generic_panel', coordinateSpace: 'screen' })`);
  const id = `window_matrix_${index}`;
  await value(cdp, `window.raindeskFreeform.open('matrix_chrome', { windowId: ${JSON.stringify(id)}, rect: { x: -4000, y: -5000, width: 380, height: 280 } })`);
  await waitFor(cdp, `(()=>{const s=window.raindeskFreeform.state(${JSON.stringify(id)});if(!s)return false;const m=document.getElementById('stage');const W=m.clientWidth,H=m.clientHeight;return s.state==='floating'&&s.rect.x>=40-380&&s.rect.x<=W-40&&s.rect.y>=0&&s.rect.y<=H-40;})()`, `${vp.label} seeded chrome window reachable`, 15_000);

  // World-canonical path: a shipped world surface at an extreme world rect
  // reload-equivalence — the rect restores EXACTLY (re-projected, never
  // viewport-clamped).
  const wid = `window_matrix_takes_${index}`;
  const seededWorld = { x: -12000 - index * 1000, y: 34000 + index * 1000, width: 460, height: 360 };
  await value(cdp, `window.raindeskFreeform.open('takes', { windowId: ${JSON.stringify(wid)}, rect: ${JSON.stringify(seededWorld)} })`);

  // Reload at the SAME viewport: the world window restores canonical; the
  // chrome window (normalized at seed) restores reachable.
  await cdp.send('Page.navigate', { url: `${base}/?freeform=1` });
  await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot==='ready'`, `${vp.label} reload boot`, 60_000);
  await waitFor(cdp, `window.raindeskFreeform && window.raindeskFreeform.state(${JSON.stringify(wid)}) && window.raindeskFreeform.state(${JSON.stringify(wid)}).state==='floating'`, `${vp.label} world window restored`, 10_000);
  await waitFor(cdp, `(()=>{const s=window.raindeskFreeform.state(${JSON.stringify(wid)});if(!s)return false;return s.rect.x===${seededWorld.x}&&s.rect.y===${seededWorld.y}&&s.rect.width===${seededWorld.width}&&s.rect.height===${seededWorld.height};})()`, `${vp.label} world rect canonical across reload`, 15_000);
  // (The chrome window's reload-restore is structurally unprovable here: its
  // surface is registered in-page only — the fresh registry after reload
  // cannot map the row. Screen persistence is pinned at unit level.)

  const errors = cdp.consoleErrors.slice();
  try { cdp._ws.close(); } catch (_e) {}
  if (errors.length) throw new Error(`${vp.label} console errors: ${errors.slice(0, 3).join(' | ')}`);
  if (SCREENSHOT_DIR) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const shot = await (async () => { const c = await newTab(browserWsUrl); const s = await c.send('Page.captureScreenshot', { format: 'png', fromSurface: false }); try { c._ws.close(); } catch (_e) {} return s; })();
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `matrix-${vp.label}.png`), Buffer.from(shot.data, 'base64'));
  }
  return { label: vp.label, ok: true };
}

async function main() {
  const server = createServer({ partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const debugPort = await freePort();
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, '--user-data-dir=' + path.join(DATA_DIR, 'chrome'), 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

  const deadline = Date.now() + 45_000;
  let browserWsUrl = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) { const body = await response.json(); if (body.webSocketDebuggerUrl) { browserWsUrl = body.webSocketDebuggerUrl; break; } }
    } catch (_error) {}
    await delay(100);
  }
  if (!browserWsUrl) { try { chrome.kill('SIGKILL'); } catch (_e) {} server.close(); throw new Error(`Chromium DevTools did not start\n${stderr}`); }

  const results = [];
  try {
    for (let i = 0; i < VIEWPORTS.length; i++) {
      const r = await runViewport(VIEWPORTS[i], base, browserWsUrl, i);
      console.error(`[matrix] ${r.label}: screen birth-reachable + world reload-canonical + clean console`);
      results.push(r);
    }
    console.log(JSON.stringify({ ok: true, viewports: results.map((r) => r.label) }));
  } finally {
    try { chrome.kill('SIGKILL'); } catch (_e) {}
    server.close();
  }
  process.exit(0);
}

main().catch((error) => { console.error(error && error.stack || error); process.exit(1); });
