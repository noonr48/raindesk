'use strict';
/** Lab witness probe: does reference-board render churn accumulate document
 *  pointerdown listeners (deferred adversarial finding A7), monotonically,
 *  with zero removals? Counts net document listeners via an addEventListener
 *  wrapper injected before app scripts. Real entrypoints only: real server,
 *  real import, real rotate clicks (each = server revision + render). */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require(require('path').join(__dirname, '..', 'public', 'js', 'canvas'));

const APP_URL = process.env.RD_URL || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || 'chromium';
const ROTATES = Number(process.env.RD_ROTATES || 5);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReferencePng() {
  const w = 96, h = 72;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = 232 - Math.round(y * 0.7); rgba[i + 1] = 205 - Math.round(x * 0.45);
    rgba[i + 2] = 160 + ((x + y) % 30); rgba[i + 3] = 255;
  }
  return Buffer.from(RC.encodePNG(w, h, rgba));
}

function waitForDevtools(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chromium DevTools did not start')), ms);
    child.stderr.on('data', (d) => {
      buf += d.toString('utf8');
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (${code})`)); });
  });
}

class CDP {
  constructor(ws) {
    this.ws = this.ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id || !this.pending.has(msg.id)) return;
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {});
    });
    this.ws = ws;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connectBlank(browserWsUrl) {
  const parsed = new URL(browserWsUrl);
  const made = await fetch(`http://${parsed.host}/json/new?about:blank`, { method: 'PUT' });
  const target = await made.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CDP(ws);
}

async function value(cdp, expression, awaitPromise = true) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(out.exceptionDetails)}`);
  return out.result && out.result.value;
}
async function waitFor(cdp, expression, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await value(cdp, expression)) return true;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function exposedPoint(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();const tests=[[.5,.5],[.3,.5],[.7,.5],[.5,.3],[.5,.7],[.25,.25],[.75,.75]];for(const [fx,fy] of tests){const x=r.left+r.width*fx,y=r.top+r.height*fy;const h=document.elementFromPoint(x,y);if(h&&(h===e||e.contains(h)))return JSON.stringify({x,y});}return null})()`, false);
  return raw ? JSON.parse(raw) : null;
}
async function nativeClick(cdp, selector) {
  const p = await exposedPoint(cdp, selector);
  if (!p) throw new Error(`click target is missing, clipped or obscured: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(420);
}

const WRAPPER = `(() => {
  const orig = EventTarget.prototype.addEventListener;
  const origRm = EventTarget.prototype.removeEventListener;
  window.__docListeners = {};
  EventTarget.prototype.addEventListener = function(type, fn, opts) {
    if (this === document) window.__docListeners[type] = (window.__docListeners[type] || 0) + 1;
    return orig.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function(type, fn, opts) {
    if (this === document) window.__docListeners[type] = Math.max(0, (window.__docListeners[type] || 0) - 1);
    return origRm.call(this, type, fn, opts);
  };
})();`;

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-leak-wit-'));
  const pngPath = path.join(profile, 'witness.png');
  fs.writeFileSync(pngPath, makeReferencePng());
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server',
    '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    cdp = await connectBlank(await waitForDevtools(child));
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WRAPPER });
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot === 'ready'`, 'Raindesk boot');
    await delay(1000);

    const sheetSel = '[data-world-id="world_references_main"]';
    const tabSel = '[data-sheet-id="sheet_references_main"]';
    const importSel = `${sheetSel} .reference-import`;
    const cardSel = `${sheetSel} .reference-card`;
    const rotateSel = `${cardSel} .reference-card-controls button[title="rotate right"]`;
    const arrangeSel = `${sheetSel} .reference-arrange-toggle`;

    const count = () => value(cdp, `window.__docListeners && (window.__docListeners['pointerdown'] || 0)`, false);
    const baseline = await count();

    await nativeClick(cdp, tabSel);
    await waitFor(cdp, `(()=>{const s=document.querySelector(${JSON.stringify(sheetSel)});const i=document.querySelector(${JSON.stringify(importSel)});return !!s&&!s.hidden&&!!i})()`, 'visible Reference Board controls');
    await waitFor(cdp, `document.querySelector('[data-reference-import="1"]') instanceof HTMLInputElement`, 'reference file input');

    const before = await value(cdp, `(async()=>{const r=await (await fetch('/api/sheet/sheet_references_main')).json();return JSON.stringify({rev:r.revisionId, n:(r.document.media||[]).length})})()`);
    const doc0 = await cdp.send('DOM.getDocument', { depth: 0, pierce: true });
    const input = await cdp.send('DOM.querySelector', { nodeId: doc0.root.nodeId, selector: '[data-reference-import="1"]' });
    await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [pngPath] });
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/sheet_references_main')).json();return r.document&&Array.isArray(r.document.media)&&r.document.media.length===1})()`, 'imported reference');
    await waitFor(cdp, `(()=>{const c=document.querySelector(${JSON.stringify(cardSel)});const img=c&&c.querySelector('img');return !!c&&!!img&&img.complete&&img.naturalWidth>0})()`, 'rendered reference card');

    const afterImport = await count();

    // Smoke-faithful order: arrange mode exposes the card controls.
    await nativeClick(cdp, arrangeSel);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(sheetSel)})?.classList.contains('reference-arrange')===true`, 'reference arrange mode');
    const afterArrange = await count();

    for (let i = 0; i < ROTATES; i++) {
      await nativeClick(cdp, rotateSel);
      await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/sheet_references_main')).json();return (r.document.media[0].rotation||0)===${(i + 1) * 5}})()`, `rotation ${((i + 1) * 5)}`);
    }
    const afterRotates = await count();
    const final = await value(cdp, `(async()=>{const r=await (await fetch('/api/sheet/sheet_references_main')).json();return JSON.stringify({rotation:r.document.media[0].rotation||0})})()`);

    console.log(JSON.stringify({ ok: true, baseline, afterImport, afterArrange, afterRotates, rotates: ROTATES, before: JSON.parse(before), final: JSON.parse(final) }));
  } finally {
    child.kill('SIGKILL');
  }
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); });
