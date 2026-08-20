'use strict';
/* Input discrimination probe: do CDP Input.dispatchMouseEvent events reach the
 * document at all, and do they arrive as click on .dtab nodes vs buttons?
 * Recorder: document-level capture listeners for pointer/mouse/click events. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-inputprobe-'));
process.env.RAINDESK_DATA_DIR = DATA_DIR;
const { createServer } = require('../server');

const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.unref(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((e) => e ? reject(e) : resolve(port)); });
  });
}
async function waitDevtools(port, child, ms = 25_000) {
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { const b = await r.json(); if (b.webSocketDebuggerUrl) return b.webSocketDebuggerUrl; }
    } catch (_e) {}
    await delay(100);
  }
  throw new Error('DevTools did not start\n' + stderr);
}
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => { const m = JSON.parse(String(event.data)); const p = this.pending.get(m.id);
      if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result || {}); }); }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12_000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
async function openPage(browserWsUrl, url) {
  const browser = new URL(browserWsUrl);
  const created = await fetch(`http://${browser.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const cdp = new CDP(ws); cdp.targetId = target.id; return cdp;
}
async function value(cdp, expression, awaitPromise = false) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails));
  return out.result && out.result.value;
}
const RECORDER = `window.__evts = [];
for (const t of ['pointerdown','pointerup','mousedown','mouseup','click','touchstart']) {
  document.addEventListener(t, (e) => {
    window.__evts.push(t + '@' + (e.target.tagName || '?') + '.' + String(e.target.className || '').split(' ').slice(0,2).join('.') + (e.defaultPrevented ? '/PREVENTED' : ''));
  }, true);
}`;
const DUMP = `JSON.stringify(window.__evts || [])`;

async function nativeClick(page, x, y, opts = {}) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  if (opts.holdMs) { await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await delay(opts.holdMs);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); }
  else { await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }); }
  await delay(opts.settleMs || 700);
}
async function center(page, sel) {
  const raw = await value(page, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2,h:(()=>{const h=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return h?(h===e||e.contains(h)?'self':h.tagName+'.'+h.className):'none'})()})})()`);
  return raw ? JSON.parse(raw) : null;
}

async function main() {
  const server = createServer({ partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) }, sourceRights: 'probe' });
  const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-inputprobe-chrome-'));
  const debugPort = await freePort();
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, '--window-size=1440,900', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let page = null;
  try {
    const browserWsUrl = await waitDevtools(debugPort, chrome);
    page = await openPage(browserWsUrl, base);
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && !(await value(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`))) await delay(150);
    await delay(3500); // settle workspace hydrate
    await value(page, RECORDER);

    // P1-TAB: plain native click on the gens tab
    let c = await center(page, '[data-tab="gens"]');
    console.log('[P1] tab hit:', c && c.h);
    await nativeClick(page, c.x, c.y);
    console.log('[P1] TAB-CLICK events:', await value(page, DUMP));
    console.log('[P1] tabActive:', await value(page, `document.querySelector('[data-tab=\"gens\"]').classList.contains('active')`));
    await value(page, `window.__evts=[]`);

    // P1-HOLD: press, hold 250ms, release (real-user cadence)
    await nativeClick(page, c.x, c.y, { holdMs: 250 });
    console.log('[P1] TAB-HOLD events:', await value(page, DUMP));
    console.log('[P1] tabActive:', await value(page, `document.querySelector('[data-tab=\"gens\"]').classList.contains('active')`));
    await value(page, `window.__evts=[]`);

    // P1-BUTTON: native click on the drawer close button (same drag-handle parent)
    const cb = await center(page, '.chat-close');
    console.log('[P1] close-btn hit:', cb && cb.h);
    const drawerOpenBefore = await value(page, `document.getElementById('drawer').classList.contains('open')`);
    await nativeClick(page, cb.x, cb.y);
    console.log('[P1] CLOSE-BTN events:', await value(page, DUMP));
    console.log('[P1] drawer open before/after:', drawerOpenBefore, await value(page, `document.getElementById('drawer').classList.contains('open')`));
    await value(page, `window.__evts=[]`);

    // P1-START: native click on a plain button in the chat list
    if (!(await value(page, `document.getElementById('drawer').classList.contains('open')`))) {
      await value(page, `document.getElementById('drawerHandle')?.click(); true`);
      await delay(400);
    }
    const sb = await center(page, '.partner-start-btn');
    console.log('[P1] start-btn hit:', sb && sb.h);
    await nativeClick(page, sb.x, sb.y);
    console.log('[P1] START-BTN events:', await value(page, DUMP));
    await value(page, `window.__evts=[]`);

    // P2: second page, same probes
    const page2 = await openPage(browserWsUrl, `${base}?reload-proof=1`);
    const old = page; page = page2;
    const t2 = Date.now();
    while (Date.now() - t2 < 30_000 && !(await value(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`))) await delay(150);
    await delay(2500);
    await value(page, RECORDER);
    const c2 = await center(page, '[data-tab="gens"]');
    console.log('[P2] tab hit:', c2 && c2.h);
    await nativeClick(page, c2.x, c2.y);
    console.log('[P2] TAB-CLICK events:', await value(page, DUMP));
    console.log('[P2] tabActive:', await value(page, `document.querySelector('[data-tab=\"gens\"]').classList.contains('active')`));
    await value(page, `window.__evts=[]`);
    const cb2 = await center(page, '.chat-close');
    await nativeClick(page, cb2.x, cb2.y);
    console.log('[P2] CLOSE-BTN events:', await value(page, DUMP));
    console.log('[P2] drawer open after:', await value(page, `document.getElementById('drawer').classList.contains('open')`));
    page = old; // restore for cleanup symmetry
  } finally {
    try { if (page && page.ws) page.ws.close(); } catch (_e) {}
    if (chrome.exitCode == null) chrome.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    for (const dir of [profile, DATA_DIR]) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  }
}
main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
