'use strict';

/**
 * Freeform Creative Desk v2 — Phase 1 native boot smoke.
 *
 * Proves, against a real Chromium:
 *   1. ?freeform=1 boots the window manager: Scenes + Layers mount as
 *      .freeform-window elements with chrome (head/body/resize).
 *   2. A native header drag moves a window (deferred capture, real input).
 *   3. The default boot (no flag) mounts nothing (flag gate holds).
 *   4. Reload of the freeform page restores the dragged window position
 *      from persisted workspace v3 state.
 *
 * Failure diagnostics follow the Gate-0 contract: phase markers, console
 * errors, DOM dump, screenshot — written on failure before cleanup.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-freeform-smoke-'));
process.env.RAINDESK_DATA_DIR = DATA_DIR;

const { createServer } = require('../server');

const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.FREEFORM_SMOKE_SCREENSHOT || '';
const DIAGNOSTICS = process.env.FREEFORM_SMOKE_DIAGNOSTICS || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let phase = 'startup';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.unref(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((e) => e ? reject(e) : resolve(port)); });
  });
}

async function waitDevtools(port, child, ms = 45_000) {
  let stderr = ''; let exited = false; let exitCode = null;
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  child.once('exit', (code) => { exited = true; exitCode = code; });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Chromium exited early (${exitCode})\n${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) { const body = await response.json(); if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl; }
    } catch (_error) {}
    await delay(100);
  }
  throw new Error(`Chromium DevTools did not start\n${stderr}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.consoleErrors = [];
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
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function openPage(browserWsUrl, url) {
  const browser = new URL(browserWsUrl);
  const created = await fetch(`http://${browser.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  return cdp;
}

async function value(cdp, expression, awaitPromise = false, timeoutMs = 12_000) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
  if (out.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(out.exceptionDetails)}`);
  return out.result && out.result.value;
}

async function waitFor(cdp, expression, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await value(cdp, expression)) return; }
    catch (error) { if (!/CDP timeout: Runtime\.evaluate/.test(String(error && error.message))) throw error; }
    await delay(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function dragWindow(cdp, windowId, dx, dy) {
  const raw = await value(cdp, `(()=>{const f=document.querySelector('[data-window-id=${JSON.stringify(windowId)}]');if(!f)return null;const h=f.querySelector('.freeform-window-head');const r=h.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`);
  if (!raw) throw new Error(`window not found for drag: ${windowId}`);
  const p = JSON.parse(raw);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: p.x + (dx * i) / 8, y: p.y + (dy * i) / 8,
      button: 'left', buttons: 1,
    });
    await delay(20);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + dx, y: p.y + dy, button: 'left', buttons: 0, clickCount: 1 });
  await delay(300);
}

async function windowRect(cdp, windowId) {
  return JSON.parse(await value(cdp, `(()=>{const f=document.querySelector('[data-window-id=${JSON.stringify(windowId)}]');if(!f)return JSON.stringify(null);return JSON.stringify({left:f.style.left,top:f.style.top,width:f.style.width});})()`));
}

async function captureDiagnostics(cdp, error) {
  const diag = { ok: !error, phase, error: error ? String(error && error.stack || error) : null };
  if (cdp) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      if (SCREENSHOT) { fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true }); fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64')); diag.screenshot = true; }
    } catch (_e) { diag.screenshot = `failed: ${_e.message}`; }
    try {
      diag.dom = await value(cdp, `(()=>{return JSON.stringify({boot:document.documentElement&&document.documentElement.dataset&&document.documentElement.dataset.raindeskBoot,windows:Array.from(document.querySelectorAll('.freeform-window')).map((f)=>({id:f.dataset.windowId,left:f.style.left,top:f.style.top,hidden:f.hidden}))})})()`);
    } catch (_e) { diag.dom = `failed: ${_e.message}`; }
    diag.consoleErrors = cdp.consoleErrors.slice(0, 20);
  }
  if (DIAGNOSTICS) {
    try { fs.mkdirSync(path.dirname(DIAGNOSTICS), { recursive: true }); fs.writeFileSync(DIAGNOSTICS, JSON.stringify(diag, null, 2) + '\n'); } catch (_e) {}
  }
  console.error(`[freeform-smoke] diagnostics: ${JSON.stringify(diag).slice(0, 600)}`);
}

async function main() {
  const watchdog = setTimeout(() => { console.error('[freeform-smoke] watchdog expired'); process.exit(124); }, 240_000);
  const server = createServer({ partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) } });
  const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-freeform-chrome-'));
  let debugPort = await freePort();
  const chromeArgs = () => ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, '--window-size=1440,900', `--user-data-dir=${profile}`, 'about:blank'];
  let chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
  async function startDevtools() {
    try { return await waitDevtools(debugPort, chrome); }
    catch (_firstError) {
      if (chrome.exitCode == null) chrome.kill('SIGKILL');
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-freeform-chrome-'));
      debugPort = await freePort();
      chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
      return await waitDevtools(debugPort, chrome);
    }
  }
  let page = null;
  try {
    try {
      // ---- Step 1: default boot mounts nothing (flag gate) ----
      phase = 'default-boot';
      const browserWsUrl = await startDevtools();
      page = await openPage(browserWsUrl, base);
      await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'default boot', 60_000);
      await delay(600);
      const defaultWindows = await value(page, `document.querySelectorAll('.freeform-window').length`);
      if (defaultWindows !== 0) throw new Error(`flag gate broken: default boot mounted ${defaultWindows} freeform windows`);
      try { page.ws.close(); } catch (_e) {}

      // ---- Step 2: freeform boot mounts Scenes + Layers with chrome ----
      phase = 'freeform-boot';
      page = await openPage(browserWsUrl, `${base}?freeform=1`);
      await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'freeform boot', 60_000);
      await waitFor(page, `document.querySelectorAll('.freeform-window').length >= 2`, 'Scenes + Layers windows mounted', 20_000);
      for (const chromeBit of ['[data-window-id="window_scenes"] .freeform-window-head', '[data-window-id="window_scenes"] .freeform-window-body', '[data-window-id="window_layers"] .freeform-window-resize', '[data-window-id="window_layers"] .freeform-window-title']) {
        await waitFor(page, `!!document.querySelector(${JSON.stringify(chromeBit)})`, `chrome ${chromeBit}`, 8_000);
      }

      // ---- Step 3: native drag moves the Scenes window ----
      phase = 'drag';
      const before = await windowRect(page, 'window_scenes');
      if (!before || !before.left) throw new Error(`scenes window has no inline rect: ${JSON.stringify(before)}`);
      await dragWindow(page, 'window_scenes', 160, 120);
      const after = await windowRect(page, 'window_scenes');
      if (!after || after.left === before.left) throw new Error(`drag did not move the window: ${JSON.stringify({ before, after })}`);
      // Let the persistence chain settle before reload.
      await delay(700);

      // ---- Step 4: reload restores the dragged position (workspace v3) ----
      phase = 'reload';
      try { page.ws.close(); } catch (_e) {}
      page = await openPage(browserWsUrl, `${base}?freeform=1`);
      await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'reload boot', 60_000);
      await waitFor(page, `!!document.querySelector('[data-window-id="window_scenes"]')`, 'scenes window restored', 20_000);
      const restored = await windowRect(page, 'window_scenes');
      if (!restored || !restored.left) throw new Error(`restored window has no rect: ${JSON.stringify(restored)}`);
      if (restored.left !== after.left || restored.top !== after.top) {
        throw new Error(`reload did not restore the dragged rect: ${JSON.stringify({ after, restored })}`);
      }

      // ---- Step 5: no console errors on the freeform page ----
      phase = 'console';
      if (page.consoleErrors.length) {
        throw new Error(`freeform boot produced console errors: ${page.consoleErrors.slice(0, 5).join(' | ')}`);
      }

      if (SCREENSHOT) {
        const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
        fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true });
        fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
      }
      clearTimeout(watchdog);
      const receipt = { ok: true, phases: ['default-boot', 'freeform-boot', 'drag', 'reload', 'console'], draggedTo: { left: after.left, top: after.top }, restoredTo: { left: restored.left, top: restored.top } };
      console.log(JSON.stringify(receipt));
      await captureDiagnostics(page, null);
    } catch (journeyError) {
      await captureDiagnostics(page, journeyError);
      throw journeyError;
    }
  } finally {
    try { if (page && page.ws) page.ws.close(); } catch (_e) {}
    if (chrome.exitCode == null) chrome.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_e) {}
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
