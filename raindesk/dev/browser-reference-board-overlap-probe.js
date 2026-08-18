'use strict';
/** Overlap baseline probe (pre-fix): two imported reference cards with
 *  intersecting rects; drag from the intersection. Acceptance (post-fix):
 *  exactly ONE card moves. Zero mocks — real server, real imports, real
 *  CDP input dispatch. Machinery cloned from dev/browser-reference-board-smoke.js. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require('/home/studio/lab/creative/raindesk-recover/raindesk/public/js/canvas');

const APP_URL = process.env.RD_URL || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || 'chromium';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const SHEET = 'sheet_references_main';

function makePng(hue) {
  const w = 96, h = 72;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = (hue + x) % 256; rgba[i + 1] = (hue + y) % 200; rgba[i + 2] = (160 + ((x + y) % 30)) % 256; rgba[i + 3] = 255;
  }
  return Buffer.from(RC.encodePNG(w, h, rgba));
}

function waitForDevtools(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chromium DevTools did not start')), ms);
    child.stderr.on('data', (d) => { buf += d.toString('utf8'); const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (${code})`)); });
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => { const msg = JSON.parse(String(event.data)); if (!msg.id || !this.pending.has(msg.id)) return; const p = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {}); }); }
  send(method, params = {}) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
async function connectBlank(wsUrl) {
  const parsed = new URL(wsUrl);
  const made = await fetch(`http://${parsed.host}/json/new?about:blank`, { method: 'PUT' });
  const target = await made.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  return new CDP(ws);
}
async function value(cdp, expression, awaitPromise = true) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(out.exceptionDetails)}`);
  return out.result && out.result.value;
}
async function waitFor(cdp, expression, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await value(cdp, expression)) return true; await delay(100); }
  throw new Error(`timed out waiting for ${label}`);
}
async function exposedPoint(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();const tests=[[.5,.5],[.3,.5],[.7,.5],[.5,.3],[.5,.7],[.25,.25],[.75,.75]];for(const [fx,fy] of tests){const x=r.left+r.width*fx,y=r.top+r.height*fy;const h=document.elementFromPoint(x,y);if(h&&(h===e||e.contains(h)))return JSON.stringify({x,y});}return null})()`, false);
  return raw ? JSON.parse(raw) : null;
}
async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(380);
}
async function nativeClick(cdp, selector) { const p = await exposedPoint(cdp, selector); if (!p) throw new Error(`target missing/obscured: ${selector}`); await click(cdp, p.x, p.y); }
async function drag(cdp, from, to) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 7; i++) { const t = i / 7; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: 'left', buttons: 1 }); await delay(35); }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(520);
}
async function media(cdp) {
  const raw = await value(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${SHEET}')).json();return JSON.stringify((r.document.media||[]).map(m=>({id:m.id,x:m.x,y:m.y,w:m.width,h:m.height})))})()`);
  return JSON.parse(raw);
}
async function rects(cdp) {
  const raw = await value(cdp, `(()=>JSON.stringify([...document.querySelectorAll('[data-world-id="world_references_main"] .reference-card')].map(c=>{const r=c.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})))()`, false);
  return JSON.parse(raw);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-ovl-'));
  fs.writeFileSync(path.join(profile, 'a.png'), makePng(40));
  fs.writeFileSync(path.join(profile, 'b.png'), makePng(180));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    cdp = await connectBlank(await waitForDevtools(child));
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot === 'ready'`, 'boot');
    await delay(1000);

    const sheetSel = '[data-world-id="world_references_main"]';
    const tabSel = `[data-sheet-id="${SHEET}"]`;
    const arrangeSel = `${sheetSel} .reference-arrange-toggle`;
    await nativeClick(cdp, tabSel);
    await waitFor(cdp, `document.querySelector('[data-reference-import="1"]') instanceof HTMLInputElement`, 'import input');

    const setFiles = async (p) => {
      const doc = await cdp.send('DOM.getDocument', { depth: 0, pierce: true });
      const input = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-reference-import="1"]' });
      await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [p] });
      await delay(600);
    };
    await setFiles(path.join(profile, 'a.png'));
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${SHEET}')).json();return (r.document.media||[]).length===1})()`, 'card A imported');
    await setFiles(path.join(profile, 'b.png'));
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${SHEET}')).json();return (r.document.media||[]).length===2})()`, 'card B imported');
    await waitFor(cdp, `document.querySelectorAll('[data-world-id="world_references_main"] .reference-card').length===2`, 'two cards rendered');

    await nativeClick(cdp, arrangeSel);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(sheetSel)})?.classList.contains('reference-arrange')===true`, 'arrange mode');

    // Overlap: imports share the default position; if not, drag card[0] (rect-center
    // coordinates — the production handler is a document-level geometric hit-test,
    // so no exposed point is needed) toward card[1].
    const cards = '[data-world-id="world_references_main"] .reference-card';
    const inter = (a, b) => ({ w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) });
    let rs = await rects(cdp);
    let ov = inter(rs[0], rs[1]);
    if (ov.w < 24 || ov.h < 24) {
      const aCenter = { x: rs[0].x + rs[0].w / 2, y: rs[0].y + rs[0].h / 2 };
      const bCenter = { x: rs[1].x + rs[1].w / 2, y: rs[1].y + rs[1].h / 2 };
      await drag(cdp, aCenter, bCenter);
      await delay(400);
      rs = await rects(cdp);
      ov = inter(rs[0], rs[1]);
    }
    if (ov.w < 24 || ov.h < 24) { console.log(JSON.stringify({ ok: false, error: 'no usable intersection', rects: rs })); return; }
    const mid = { x: Math.max(rs[0].x, rs[1].x) + ov.w / 2, y: Math.max(rs[0].y, rs[1].y) + ov.h / 2 };

    const before = await media(cdp);
    await drag(cdp, mid, { x: mid.x + 40, y: mid.y + 30 });
    const after = await media(cdp);
    const moved = after.map((m, i) => Math.abs(m.x - before[i].x) > 20 || Math.abs(m.y - before[i].y) > 12);
    console.log(JSON.stringify({ ok: true, intersection: { w: ov.w, h: ov.h }, moved, before, after, doubleClaim: moved.filter(Boolean).length > 1 }));
  } finally { child.kill('SIGKILL'); }
}
main().catch((e) => { console.error(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); });
