'use strict';

/** Native Chromium smoke for Reference Board v1 media + drawing revision coexistence. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require('../public/js/canvas');

const APP_URL = process.argv[2] || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.REFERENCE_BOARD_SCREENSHOT || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeReferencePng() {
  const w = 96, h = 72;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 232 - Math.round(y * 0.7);
      rgba[i + 1] = 205 - Math.round(x * 0.45);
      rgba[i + 2] = 160 + ((x + y) % 30);
      rgba[i + 3] = 255;
      if ((x > 18 && x < 28) || (y > 46 && y < 53)) {
        rgba[i] = 63; rgba[i + 1] = 83; rgba[i + 2] = 90;
      }
    }
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
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (${code})\n${buf}`)); });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id || !this.pending.has(msg.id)) return;
      const pending = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message)); else pending.resolve(msg.result || {});
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
  const made = await fetch(`http://${parsed.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!made.ok) throw new Error(`could not create Chromium page: HTTP ${made.status}`);
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
async function waitBoot(cdp) {
  return waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot === 'ready'`, 'Raindesk boot');
}
async function jsonFrom(cdp, route) {
  const raw = await value(cdp, `(async()=>JSON.stringify(await (await fetch(${JSON.stringify(route)})).json()))()`);
  return JSON.parse(raw);
}
async function box(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,width:r.width,height:r.height})})()`);
  return raw ? JSON.parse(raw) : null;
}
async function exposedPoint(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();const tests=[[.5,.5],[.3,.5],[.7,.5],[.5,.3],[.5,.7],[.25,.25],[.75,.75]];for(const [fx,fy] of tests){const x=r.left+r.width*fx,y=r.top+r.height*fy;const h=document.elementFromPoint(x,y);if(h&&(h===e||e.contains(h)))return JSON.stringify({x,y});}return null})()`);
  return raw ? JSON.parse(raw) : null;
}
async function nativeClick(cdp, selector) {
  const p = await exposedPoint(cdp, selector);
  if (!p) throw new Error(`click target is missing, clipped or obscured: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(280);
}
async function drag(cdp, from, to) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 7; i++) {
    const t = i / 7;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
      button: 'left', buttons: 1,
    });
    await delay(35);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(520);
}
async function setFileInput(cdp, selector, filePath) {
  const doc = await cdp.send('DOM.getDocument', { depth: 0, pierce: true });
  const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!found.nodeId) throw new Error(`file input missing: ${selector}`);
  await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [filePath] });
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-reference-board-chrome-'));
  const pngPath = path.join(profile, 'rooftop-reference.png');
  fs.writeFileSync(pngPath, makeReferencePng());
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server',
    '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const browserWs = await waitForDevtools(child);
    cdp = await connectPage(browserWs, APP_URL);
    await waitBoot(cdp); await delay(1000);

    const sheetId = 'sheet_references_main';
    const sheetSel = '[data-world-id="world_references_main"]';
    const tabSel = '[data-sheet-id="sheet_references_main"]';
    const canvasSel = `${sheetSel} .creative-sheet-canvas`;
    const importSel = `${sheetSel} .reference-import`;
    const arrangeSel = `${sheetSel} .reference-arrange-toggle`;
    const cardSel = `${sheetSel} .reference-card`;
    const resizeSel = `${cardSel} .reference-card-resize`;
    const rotateSel = `${cardSel} .reference-card-controls button[title="rotate right"]`;

    await nativeClick(cdp, tabSel);
    await waitFor(cdp, `(()=>{const s=document.querySelector(${JSON.stringify(sheetSel)});const i=document.querySelector(${JSON.stringify(importSel)});return !!s&&!s.hidden&&!!i})()`, 'visible Reference Board controls');
    if (!await exposedPoint(cdp, importSel)) throw new Error('reference import control is not genuinely reachable');
    await waitFor(cdp, `document.querySelector('[data-reference-import="1"]') instanceof HTMLInputElement`, 'reference file input');

    const beforeImport = await jsonFrom(cdp, `/api/sheet/${sheetId}`);
    await setFileInput(cdp, '[data-reference-import="1"]', pngPath);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${sheetId}')).json();return r.document&&Array.isArray(r.document.media)&&r.document.media.length===1})()`, 'imported immutable reference');
    let revision = await jsonFrom(cdp, `/api/sheet/${sheetId}`);
    if (revision.revisionId === beforeImport.revisionId) throw new Error('reference import did not create a sheet revision');
    const imported = revision.document.media[0];
    if (!imported || !/^[a-f0-9]{64}$/.test(imported.sha)) throw new Error(`reference import did not persist an immutable blob sha: ${JSON.stringify(imported)}`);
    const blobRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/blob/${imported.sha}`);
    if (!blobRes.ok || !String(blobRes.headers.get('content-type') || '').includes('image/png')) throw new Error('imported reference blob is not retrievable as PNG');
    await waitFor(cdp, `(()=>{const c=document.querySelector(${JSON.stringify(cardSel)});const img=c&&c.querySelector('img');return !!c&&!!img&&img.complete&&img.naturalWidth>0})()`, 'rendered reference image');

    await nativeClick(cdp, arrangeSel);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(sheetSel)})?.classList.contains('reference-arrange')===true`, 'reference arrange mode');
    const cardPoint = await exposedPoint(cdp, cardSel); const cardBox = await box(cdp, cardSel);
    if (!cardPoint || !cardBox) throw new Error('reference card is not genuinely draggable');
    const beforeMove = { x: imported.x, y: imported.y };
    await drag(cdp, cardPoint, { x: cardPoint.x + 40, y: cardPoint.y + 30 });
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${sheetId}')).json();const m=r.document&&r.document.media&&r.document.media[0];return m&&Math.abs(m.x-(${beforeMove.x}))>20&&Math.abs(m.y-(${beforeMove.y}))>12})()`, 'reference card move persistence');
    revision = await jsonFrom(cdp, `/api/sheet/${sheetId}`);
    const moved = revision.document.media[0];

    const resizePoint = await exposedPoint(cdp, resizeSel);
    if (!resizePoint) throw new Error('reference resize handle is clipped or obscured');
    await drag(cdp, resizePoint, { x: resizePoint.x + 40, y: resizePoint.y + 20 });
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${sheetId}')).json();const m=r.document&&r.document.media&&r.document.media[0];return m&&m.width>${moved.width + 18}})()`, 'reference resize persistence');

    await nativeClick(cdp, rotateSel);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${sheetId}')).json();const m=r.document&&r.document.media&&r.document.media[0];return m&&Math.abs(m.rotation-5)<0.01})()`, 'reference rotation persistence');
    revision = await jsonFrom(cdp, `/api/sheet/${sheetId}`);
    const arranged = revision.document.media[0];
    const mediaRevisionId = revision.revisionId;

    // Return to draw mode. CreativeDesk still has its older local revision.
    // The next stroke must hit a 409, merge the media-only server advancement,
    // and retry without losing either the reference transform or raw stroke.
    await nativeClick(cdp, arrangeSel);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(sheetSel)})?.classList.contains('reference-arrange')===false`, 'reference draw mode');
    const canvasBox = await box(cdp, canvasSel); const drawStart = await exposedPoint(cdp, canvasSel);
    if (!canvasBox || !drawStart) throw new Error('reference canvas is not exposed for drawing-over-media');
    await drag(cdp, drawStart, {
      x: Math.min(canvasBox.x + canvasBox.width * 0.78, drawStart.x + Math.max(65, canvasBox.width * 0.18)),
      y: Math.min(canvasBox.y + canvasBox.height * 0.78, drawStart.y + Math.max(42, canvasBox.height * 0.12)),
    });
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${sheetId}')).json();const d=r.document,m=d&&d.media&&d.media[0];return d&&d.strokes&&d.strokes.length===1&&d.media.length===1&&m.sha===${JSON.stringify(imported.sha)}&&Math.abs(m.rotation-5)<0.01})()`, 'stroke + reference media orthogonal merge');
    revision = await jsonFrom(cdp, `/api/sheet/${sheetId}`);
    if (revision.revisionId === mediaRevisionId) throw new Error('drawing over reference did not create a new merged revision');
    const finalMedia = revision.document.media[0];
    if (Math.abs(finalMedia.x - arranged.x) > 0.001 || Math.abs(finalMedia.y - arranged.y) > 0.001 || Math.abs(finalMedia.width - arranged.width) > 0.001 || Math.abs(finalMedia.rotation - arranged.rotation) > 0.001) {
      throw new Error('drawing save rewrote the arranged reference transform');
    }

    const history = await jsonFrom(cdp, `/api/sheet/${sheetId}/revisions`);
    if (!history.revisions || history.revisions.length < 5) throw new Error(`reference sheet revision history too short: ${history.revisions && history.revisions.length}`);
    if (SCREENSHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }

    const beforeReloadRevision = revision.revisionId;
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitBoot(cdp); await delay(1200);
    const after = await jsonFrom(cdp, `/api/sheet/${sheetId}`);
    if (after.revisionId !== beforeReloadRevision || after.document.strokes.length !== 1 || after.document.media.length !== 1) throw new Error('reference board document did not survive reload');
    const afterMedia = after.document.media[0];
    for (const key of ['x', 'y', 'width', 'height', 'rotation']) {
      if (Math.abs(Number(afterMedia[key]) - Number(finalMedia[key])) > 0.001) throw new Error(`reference ${key} did not survive reload`);
    }
    await nativeClick(cdp, tabSel);
    await waitFor(cdp, `(()=>{const c=document.querySelector(${JSON.stringify(cardSel)});const img=c&&c.querySelector('img');return !!c&&!!img&&img.complete&&img.naturalWidth>0})()`, 'rehydrated reference card DOM');

    console.log(JSON.stringify({
      ok: true,
      sheetId,
      revisionId: after.revisionId,
      revisions: history.revisions.length,
      strokeCount: after.document.strokes.length,
      media: { sha: afterMedia.sha, x: afterMedia.x, y: afterMedia.y, width: afterMedia.width, height: afterMedia.height, rotation: afterMedia.rotation },
    }));
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_e) {}
    child.kill('SIGTERM'); await delay(100);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
  }
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
