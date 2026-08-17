'use strict';

/** Native Chromium smoke for Creative Sheets v1 document + world round-trip. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_URL = process.argv[2] || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.CREATIVE_SHEETS_SCREENSHOT || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {});
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
async function jsonFrom(cdp, path) {
  const raw = await value(cdp, `(async()=>JSON.stringify(await (await fetch(${JSON.stringify(path)})).json()))()`);
  return JSON.parse(raw);
}
async function box(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,width:r.width,height:r.height})})()`);
  return raw ? JSON.parse(raw) : null;
}
async function exposedPoint(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();const tests=[[.5,.5],[.3,.5],[.7,.5],[.5,.35],[.5,.65],[.25,.3],[.75,.7]];for(const [fx,fy] of tests){const x=r.left+r.width*fx,y=r.top+r.height*fy;const h=document.elementFromPoint(x,y);if(h&&(h===e||e.contains(h)))return JSON.stringify({x,y});}return null})()`);
  return raw ? JSON.parse(raw) : null;
}
async function nativeClick(cdp, selector) {
  const p = await exposedPoint(cdp, selector);
  if (!p) throw new Error(`click target is missing, clipped or obscured: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(250);
}
async function nativeDoubleClick(cdp, selector) {
  const p = await exposedPoint(cdp, selector);
  if (!p) throw new Error(`double-click target is missing, clipped or obscured: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (const count of [1, 2]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: count });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: count });
    await delay(70);
  }
}
async function drag(cdp, from, to, { button = 'left' } = {}) {
  const buttons = button === 'middle' ? 4 : 1;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button, buttons, clickCount: 1 });
  for (let i = 1; i <= 7; i++) {
    const t = i / 7;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t,
      button, buttons,
    });
    await delay(35);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button, buttons: 0, clickCount: 1 });
  await delay(450);
}
async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-creative-sheets-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server',
    '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const browserWs = await waitForDevtools(child);
    cdp = await connectPage(browserWs, APP_URL);
    await waitBoot(cdp); await delay(900);

    await nativeClick(cdp, '[data-creative-new-sheet="1"]');
    await waitFor(cdp, `(async()=>{const j=await (await fetch('/api/sheets')).json();return (j.sheets||[]).some(s=>s.kind==='sketch'&&/^Loose sketch/.test(s.title))})()`, 'loose sheet creation');
    const list = await jsonFrom(cdp, '/api/sheets');
    const loose = (list.sheets || []).find((s) => s.kind === 'sketch' && /^Loose sketch/.test(s.title));
    if (!loose) throw new Error('created loose sheet could not be identified');
    const sheetId = loose.sheetId;
    const objectId = `world_sheet_${sheetId}`;
    const qSheet = JSON.stringify(sheetId);
    const qObject = JSON.stringify(objectId);
    const sheetSel = `[data-world-id="${objectId}"]`;
    const canvasSel = `${sheetSel} .creative-sheet-canvas`;
    const titleSel = `${sheetSel} .creative-sheet-title`;
    const undoSel = `${sheetSel} .creative-sheet-undo`;
    const tabSel = `[data-sheet-id="${sheetId}"]`;

    await waitFor(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(canvasSel)});return !!e&&!e.closest('.creative-sheet').hidden})()`, 'loose sheet canvas');
    const canvasBox = await box(cdp, canvasSel);
    const start = await exposedPoint(cdp, canvasSel);
    if (!canvasBox || !start) throw new Error('loose sheet canvas is not genuinely drawable');
    const end = {
      x: Math.max(canvasBox.x + canvasBox.width * 0.25, Math.min(canvasBox.x + canvasBox.width * 0.78, start.x + Math.max(55, canvasBox.width * 0.2))),
      y: Math.max(canvasBox.y + canvasBox.height * 0.2, Math.min(canvasBox.y + canvasBox.height * 0.78, start.y + Math.max(35, canvasBox.height * 0.12))),
    };
    await drag(cdp, start, end);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/'+encodeURIComponent(${qSheet}))).json();return r.document&&r.document.strokes&&r.document.strokes.length===1})()`, 'persisted sheet stroke');
    let revision = await jsonFrom(cdp, `/api/sheet/${encodeURIComponent(sheetId)}`);
    const drawnRevisionId = revision.revisionId;

    // Space-drag from the sheet itself must pan the world and never become a second stroke.
    const beforePan = await jsonFrom(cdp, '/api/workspace');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    const panStart = await exposedPoint(cdp, canvasSel);
    if (!panStart) throw new Error('sheet has no exposed point for world pan');
    await drag(cdp, panStart, { x: panStart.x + 90, y: panStart.y + 55 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();return Math.abs(w.viewport.x-(${beforePan.viewport.x}))>55&&Math.abs(w.viewport.y-(${beforePan.viewport.y}))>30})()`, 'sheet-originated world pan');
    revision = await jsonFrom(cdp, `/api/sheet/${encodeURIComponent(sheetId)}`);
    if (revision.revisionId !== drawnRevisionId || revision.document.strokes.length !== 1) throw new Error('world pan mutated the sheet document');

    const renamed = 'Rooftop hand studies';
    await nativeDoubleClick(cdp, titleSel);
    await waitFor(cdp, `document.querySelector(${JSON.stringify(titleSel)})?.getAttribute('contenteditable')==='true'`, 'sheet rename editor');
    await cdp.send('Input.insertText', { text: renamed });
    await pressEnter(cdp);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/'+encodeURIComponent(${qSheet}))).json();return r.document&&r.document.title===${JSON.stringify(renamed)}})()`, 'persisted sheet rename');

    await nativeClick(cdp, undoSel);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/'+encodeURIComponent(${qSheet}))).json();return r.document&&r.document.strokes&&r.document.strokes.length===0})()`, 'persisted sheet undo');

    const redrawStart = await exposedPoint(cdp, canvasSel);
    const redrawBox = await box(cdp, canvasSel);
    if (!redrawStart || !redrawBox) throw new Error('sheet canvas unavailable after undo');
    await drag(cdp, redrawStart, {
      x: Math.min(redrawBox.x + redrawBox.width * 0.78, redrawStart.x + Math.max(65, redrawBox.width * 0.24)),
      y: Math.max(redrawBox.y + redrawBox.height * 0.22, redrawStart.y - Math.max(30, redrawBox.height * 0.10)),
    });
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/'+encodeURIComponent(${qSheet}))).json();return r.document&&r.document.strokes&&r.document.strokes.length===1&&r.document.title===${JSON.stringify(renamed)}})()`, 'redrawn sheet persistence');

    const head = await exposedPoint(cdp, `${sheetSel} .creative-sheet-head`);
    const tabsBox = await box(cdp, '#creativeTabs');
    if (!head || !tabsBox) throw new Error('sheet/tab geometry unavailable for put-away');
    await drag(cdp, head, { x: tabsBox.x + tabsBox.width * 0.52, y: tabsBox.y + tabsBox.height * 0.5 });
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();const o=(w.objects||[]).find(x=>x.id===${qObject});return o&&o.visible===false&&o.collapsed===true})()`, 'sheet put-away');

    const hiddenWs = await jsonFrom(cdp, '/api/workspace');
    const hiddenObj = (hiddenWs.objects || []).find((o) => o.id === objectId);
    if (!hiddenObj) throw new Error('loose sheet world object missing after put-away');
    const tabPoint = await exposedPoint(cdp, tabSel);
    const stage = await box(cdp, '#stage');
    if (!tabPoint || !stage) throw new Error('loose sheet tab/stage unavailable for tear-out');
    const drop = { x: stage.x + stage.width * 0.31, y: stage.y + stage.height * 0.68 };
    await drag(cdp, tabPoint, drop);
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();const o=(w.objects||[]).find(x=>x.id===${qObject});return o&&o.visible===true&&!o.collapsed&&(Math.abs(o.x-(${hiddenObj.x}))>20||Math.abs(o.y-(${hiddenObj.y}))>20)})()`, 'sheet tear-out');

    const beforeReloadWs = await jsonFrom(cdp, '/api/workspace');
    const beforeReloadObj = (beforeReloadWs.objects || []).find((o) => o.id === objectId);
    const beforeReloadRevision = await jsonFrom(cdp, `/api/sheet/${encodeURIComponent(sheetId)}`);
    const history = await jsonFrom(cdp, `/api/sheet/${encodeURIComponent(sheetId)}/revisions`);
    if (!history.revisions || history.revisions.length < 5) throw new Error(`sheet revision history too short: ${history.revisions && history.revisions.length}`);

    if (SCREENSHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitBoot(cdp); await delay(1000);
    const afterRevision = await jsonFrom(cdp, `/api/sheet/${encodeURIComponent(sheetId)}`);
    const afterWs = await jsonFrom(cdp, '/api/workspace');
    const afterObj = (afterWs.objects || []).find((o) => o.id === objectId);
    if (!afterObj || !afterObj.visible || afterObj.collapsed) throw new Error('loose sheet visibility did not survive reload');
    if (Math.abs(afterObj.x - beforeReloadObj.x) > 0.001 || Math.abs(afterObj.y - beforeReloadObj.y) > 0.001) throw new Error('loose sheet world placement did not survive reload');
    if (afterRevision.revisionId !== beforeReloadRevision.revisionId || afterRevision.document.title !== renamed || afterRevision.document.strokes.length !== 1) throw new Error('loose sheet creative content did not survive reload');
    await waitFor(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(titleSel)});const t=document.querySelector(${JSON.stringify(tabSel)});return !!e&&!!t&&e.textContent===${JSON.stringify(renamed)}&&t.textContent===${JSON.stringify(renamed)}})()`, 'rehydrated sheet DOM');

    console.log(JSON.stringify({
      ok: true,
      sheetId,
      title: afterRevision.document.title,
      revisionId: afterRevision.revisionId,
      revisions: history.revisions.length,
      strokeCount: afterRevision.document.strokes.length,
      world: { x: afterObj.x, y: afterObj.y, visible: afterObj.visible },
      viewport: afterWs.viewport,
    }));
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_e) {}
    child.kill('SIGTERM'); await delay(100);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
  }
}

main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
