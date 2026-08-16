'use strict';

/**
 * Dependency-free Chromium/CDP integrity smoke.
 *
 * Proves the real browser can edit a vector layer, persist it as an immutable
 * ShotDocument, reload, continue editing, undo the new edit, and persist the
 * restored vector state.  This deliberately tests the production frontend
 * rather than evaluating source strings.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_URL = process.argv[2] || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result || {});
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connectPage(browserWsUrl, url) {
  const parsed = new URL(browserWsUrl);
  const listBase = `http://${parsed.host}`;
  const created = await fetch(`${listBase}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!created.ok) throw new Error(`could not create Chromium page: HTTP ${created.status}`);
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

async function value(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result && result.result.value;
}

async function waitBoot(cdp, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ready = await value(cdp, `!!document.documentElement && document.documentElement.getAttribute('data-raindesk-boot') === 'ready'`);
    if (ready) return;
    await timeout(100);
  }
  throw new Error('Raindesk browser boot marker never became ready');
}

async function documentState(cdp) {
  const raw = await value(cdp, `(async()=>{
    const r=await fetch('/api/shot/S01/document');
    if(!r.ok) return JSON.stringify({status:r.status});
    const x=await r.json();
    const layers=(x.document&&x.document.layers)||[];
    return JSON.stringify({
      status:r.status,
      revisionId:x.revisionId,
      vector:layers.filter(l=>l.kind==='pen'||l.kind==='vector').map(l=>({id:l.id,strokes:(l.strokes||[]).length}))
    });
  })()`);
  return JSON.parse(raw);
}

async function drawStroke(cdp, dx = 0) {
  // Use the CDP input domain rather than dispatchEvent(new PointerEvent(...)).
  // Synthetic DOM PointerEvents are not registered as active pointers by
  // Chromium, so app.js setPointerCapture(pointerId) correctly rejects them.
  // CDP mouse input exercises the same native pointer path as a real artist.
  const raw = await value(cdp, `(()=>{
    const c=document.getElementById('canvas');
    const r=c.getBoundingClientRect();
    return JSON.stringify({
      x:r.left+r.width*0.42+${Number(dx)},
      y:r.top+r.height*0.42
    });
  })()`);
  const { x, y } = JSON.parse(raw);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: x + 24, y: y + 12, button: 'left', buttons: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: x + 48, y: y + 22, button: 'left', buttons: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x + 48, y: y + 22, button: 'left', buttons: 0, clickCount: 1,
  });
  await timeout(1300);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const browserWs = await waitForDevtools(child);
    cdp = await connectPage(browserWs, APP_URL);
    await waitBoot(cdp);

    // Let the first-open legacy import create its initial editable revision.
    await timeout(1400);
    const initial = await documentState(cdp);
    if (initial.status !== 200 || !initial.revisionId) throw new Error(`initial editable revision missing: ${JSON.stringify(initial)}`);

    await drawStroke(cdp, 0);
    const one = await documentState(cdp);
    const oneCount = one.vector.reduce((n, l) => n + l.strokes, 0);
    if (oneCount !== 1) throw new Error(`expected one durable stroke before reload, got ${JSON.stringify(one)}`);

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitBoot(cdp);
    await timeout(700);
    const reloaded = await documentState(cdp);
    const reloadCount = reloaded.vector.reduce((n, l) => n + l.strokes, 0);
    if (reloadCount !== 1) throw new Error(`editable stroke did not survive reload: ${JSON.stringify(reloaded)}`);

    await drawStroke(cdp, 22);
    let two = await documentState(cdp);
    const twoCount = two.vector.reduce((n, l) => n + l.strokes, 0);
    if (twoCount !== 2) throw new Error(`expected two strokes after resumed edit: ${JSON.stringify(two)}`);

    await value(cdp, `(async()=>{ document.getElementById('undoBtn').click(); await new Promise(r=>setTimeout(r,1100)); return true; })()`);
    const undone = await documentState(cdp);
    const undoCount = undone.vector.reduce((n, l) => n + l.strokes, 0);
    if (undoCount !== 1) throw new Error(`durable undo did not restore one-stroke state: ${JSON.stringify(undone)}`);
    if (undone.revisionId === reloaded.revisionId) throw new Error('undo did not create a new durable revision');

    console.log(JSON.stringify({ ok: true, initial: initial.revisionId, afterDraw: one.revisionId, afterReload: reloaded.revisionId, afterUndo: undone.revisionId, strokes: undoCount }));
  } finally {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (_e) {}
    try { child.kill('SIGKILL'); } catch (_e) {}
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
