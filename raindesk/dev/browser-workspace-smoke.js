'use strict';

/**
 * Chromium/CDP smoke for the desktop floating workspace shell.
 *
 * Proves a real desktop session can open a hidden panel from the shelf,
 * drag it, magnetically dock it, minimise it, reopen it, reload, and recover
 * the same persisted workspace state.  Uses native CDP mouse input so the
 * test exercises pointer capture just like the artist.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_URL = process.argv[2] || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForDevtools(child, ms = 10000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chromium DevTools did not start')), ms);
    child.stderr.on('data', (d) => {
      buf += d.toString('utf8');
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (${code})\n${buf}`)); });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result || {});
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connectPage(browserWsUrl, url) {
  const parsed = new URL(browserWsUrl);
  const made = await fetch(`http://${parsed.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!made.ok) throw new Error(`could not create Chromium page: HTTP ${made.status}`);
  const target = await made.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

async function value(cdp, expression, awaitPromise = true) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(out.exceptionDetails)}`);
  return out.result && out.result.value;
}

async function waitBoot(cdp, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await value(cdp, `document.documentElement && document.documentElement.getAttribute('data-raindesk-boot') === 'ready'`)) return;
    await delay(100);
  }
  throw new Error('Raindesk browser boot marker never became ready');
}

async function workspace(cdp) {
  const raw = await value(cdp, `(async()=>{const r=await fetch('/api/workspace');return JSON.stringify(await r.json())})()`);
  return JSON.parse(raw);
}
function object(ws, id) { return (ws.objects || []).find((o) => o.id === id); }

async function box(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,width:r.width,height:r.height})})()`);
  return raw ? JSON.parse(raw) : null;
}

async function drag(cdp, from, to) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i++) {
    const t = i / 5;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: 'left', buttons: 1 });
    await delay(30);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(500);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-workspace-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
    '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const browserWs = await waitForDevtools(child);
    cdp = await connectPage(browserWs, APP_URL);
    await waitBoot(cdp); await delay(600);

    let ws = await workspace(cdp);
    for (const id of ['panel_layers', 'panel_scenes', 'panel_beats', 'panel_partner']) {
      if (!object(ws, id)) throw new Error(`workspace did not seed ${id}`);
    }
    const stageWidth = Number(await value(cdp, `document.getElementById('stage').getBoundingClientRect().width`));
    if (stageWidth < 1300) throw new Error(`floating Partner still steals permanent art width (${stageWidth})`);

    // Open Scenes from the shelf.
    await value(cdp, `document.querySelector('[data-workspace-target="panel_scenes"]').click(); true`);
    await delay(450);
    let scenes = object(await workspace(cdp), 'panel_scenes');
    if (!scenes || !scenes.visible) throw new Error('Scenes did not open from workspace shelf');

    // Move freely first.
    let head = await box(cdp, '#scenesPanel .workspace-panel-head strong');
    if (!head) throw new Error('Scenes drag handle missing');
    await drag(cdp, { x: head.x + 16, y: head.y + head.height / 2 }, { x: 690, y: 260 });
    scenes = object(await workspace(cdp), 'panel_scenes');
    if (!scenes || scenes.x < 500 || scenes.dock) throw new Error(`Scenes did not persist free drag: ${JSON.stringify(scenes)}`);

    // Drag back to the left magnet; release close enough to dock.
    head = await box(cdp, '#scenesPanel .workspace-panel-head strong');
    await drag(cdp, { x: head.x + 16, y: head.y + head.height / 2 }, { x: 12, y: 300 });
    scenes = object(await workspace(cdp), 'panel_scenes');
    if (!scenes || scenes.dock !== 'left') throw new Error(`Scenes did not magnetically dock left: ${JSON.stringify(scenes)}`);

    // Minimise to the persistent shelf.
    await value(cdp, `document.querySelector('#scenesPanel [data-workspace-minimize]').click(); true`);
    await delay(350);
    scenes = object(await workspace(cdp), 'panel_scenes');
    if (!scenes || scenes.visible !== false || !scenes.collapsed) throw new Error(`Scenes minimise did not persist: ${JSON.stringify(scenes)}`);

    // Reopen via shelf, then reload and make sure the docked state survives.
    await value(cdp, `document.querySelector('[data-workspace-target="panel_scenes"]').click(); true`);
    await delay(350);
    scenes = object(await workspace(cdp), 'panel_scenes');
    if (!scenes || !scenes.visible || scenes.dock !== 'left') throw new Error(`Scenes reopen lost state: ${JSON.stringify(scenes)}`);

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitBoot(cdp); await delay(650);
    scenes = object(await workspace(cdp), 'panel_scenes');
    const shown = Boolean(await value(cdp, `document.getElementById('scenesPanel').classList.contains('open')`));
    if (!scenes || scenes.dock !== 'left' || !scenes.visible || !shown) throw new Error(`workspace state did not survive reload: ${JSON.stringify({scenes,shown})}`);

    console.log(JSON.stringify({ ok: true, stageWidth, scenes: { x: scenes.x, y: scenes.y, dock: scenes.dock, visible: scenes.visible }, panels: ws.objects.length }));
  } finally {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (_e) {}
    try { child.kill('SIGKILL'); } catch (_e) {}
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
