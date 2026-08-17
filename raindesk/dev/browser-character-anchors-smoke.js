'use strict';

/** Native Chromium smoke for Character Anchors v1 identity locking and shot binding. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RC = require('../public/js/canvas');

const APP_URL = process.argv[2] || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.CHARACTER_ANCHORS_SCREENSHOT || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makePng(seed = 0) {
  const w = 80, h = 96; const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = 60 + ((x + seed * 17) % 120); rgba[i + 1] = 105 + ((y + seed * 11) % 100); rgba[i + 2] = 150 + ((x + y + seed) % 80); rgba[i + 3] = 255;
    if (x > 25 && x < 55 && y > 18 && y < 72) { rgba[i] = 205 - seed * 15; rgba[i + 1] = 185; rgba[i + 2] = 165 + seed * 8; }
  }
  return Buffer.from(RC.encodePNG(w, h, rgba));
}
function waitForDevtools(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    let buf = ''; const timer = setTimeout(() => reject(new Error('Chromium DevTools did not start')), ms);
    child.stderr.on('data', (d) => { buf += d.toString('utf8'); const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf); if (m) { clearTimeout(timer); resolve(m[1]); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited early (${code})\n${buf}`)); });
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); ws.addEventListener('message', (event) => { const msg = JSON.parse(String(event.data)); if (!msg.id || !this.pending.has(msg.id)) return; const p = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {}); }); }
  send(method, params = {}) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
}
async function connectPage(browserWsUrl, url) {
  const parsed = new URL(browserWsUrl); const made = await fetch(`http://${parsed.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!made.ok) throw new Error(`could not create Chromium page: HTTP ${made.status}`); const target = await made.json(); const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }); return new CDP(ws);
}
async function value(cdp, expression, awaitPromise = true) { const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }); if (out.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(out.exceptionDetails)}`); return out.result && out.result.value; }
async function waitFor(cdp, expression, label, ms = 15000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await value(cdp, expression)) return true; await delay(100); } throw new Error(`timed out waiting for ${label}`); }
async function waitBoot(cdp) { return waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot === 'ready'`, 'Raindesk boot'); }
async function jsonFrom(cdp, route) { const raw = await value(cdp, `(async()=>JSON.stringify(await (await fetch(${JSON.stringify(route)})).json()))()`); return JSON.parse(raw); }
async function exposedPoint(cdp, selector) { const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();for(const [fx,fy] of [[.5,.5],[.3,.5],[.7,.5],[.5,.3],[.5,.7]]){const x=r.left+r.width*fx,y=r.top+r.height*fy,h=document.elementFromPoint(x,y);if(h&&(h===e||e.contains(h)))return JSON.stringify({x,y});}return null})()`); return raw ? JSON.parse(raw) : null; }
async function nativeClick(cdp, selector) { const p = await exposedPoint(cdp, selector); if (!p) throw new Error(`click target missing, clipped or obscured: ${selector}`); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 }); await delay(320); }
async function setFileInput(cdp, filePath) { const doc = await cdp.send('DOM.getDocument', { depth: 0, pierce: true }); const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-reference-import="1"]' }); if (!found.nodeId) throw new Error('shared media file input missing'); await cdp.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [filePath] }); }

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-character-anchors-chrome-'));
  const firstFile = path.join(profile, 'character-front.png'); const secondFile = path.join(profile, 'character-expression.png'); fs.writeFileSync(firstFile, makePng(1)); fs.writeFileSync(secondFile, makePng(2));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    cdp = await connectPage(await waitForDevtools(child), APP_URL); await waitBoot(cdp); await delay(1100);
    const sheetId = 'sheet_character_primary'; const characterId = 'character_primary'; const shotId = 'S01';
    const sheetSel = '[data-world-id="world_character_primary"]'; const tabSel = '[data-sheet-id="sheet_character_primary"]';
    const importSel = `${sheetSel} .reference-import`; const lockSel = `${sheetSel} .character-anchor-lock`; const bindSel = `${sheetSel} .character-shot-bind`;

    await nativeClick(cdp, tabSel);
    await waitFor(cdp, `!!document.querySelector(${JSON.stringify(importSel)})&&!!document.querySelector(${JSON.stringify(lockSel)})`, 'Character identity controls');
    await waitFor(cdp, `document.querySelector(${JSON.stringify(bindSel)})?.disabled===false`, 'rough shot binding enabled');
    await nativeClick(cdp, bindSel);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/character/shot/${shotId}')).json();return r.characterIds&&r.characterIds.includes('${characterId}')&&r.characters[0].locked===false})()`, 'unlocked Character bound to active shot');
    await nativeClick(cdp, importSel); await setFileInput(cdp, firstFile);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${sheetId}')).json();return r.document&&r.document.media&&r.document.media.length===1})()`, 'first Character image');
    await waitFor(cdp, `document.querySelector(${JSON.stringify(lockSel)})?.disabled===false`, 'identity lock enabled');
    await nativeClick(cdp, lockSel);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/character/${characterId}')).json();return r.locked===true&&r.anchors&&r.anchors.length===1})()`, 'locked Character identity');
    let character = await jsonFrom(cdp, `/api/character/${characterId}`); const firstSha = character.anchors[0].sha;
    if (!/^[a-f0-9]{64}$/.test(firstSha)) throw new Error('identity lock is not backed by immutable image sha');

    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/character/shot/${shotId}')).json();return r.characterIds&&r.characterIds.includes('${characterId}')&&r.characters[0].locked===true})()`, 'bound Character now carries pinned identity authority');
    await nativeClick(cdp, lockSel);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/character/${characterId}')).json();return r.locked===false})()`, 'explicit identity unpin');
    await nativeClick(cdp, lockSel);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/character/${characterId}')).json();return r.locked===true&&r.anchors&&r.anchors.length===1})()`, 'identity re-pin');

    await nativeClick(cdp, importSel); await setFileInput(cdp, secondFile);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/sheet/${sheetId}')).json();return r.document&&r.document.media&&r.document.media.length===2})()`, 'second Character image');
    await waitFor(cdp, `document.querySelector(${JSON.stringify(lockSel)})?.classList.contains('stale')===true&&document.querySelector(${JSON.stringify(lockSel)})?.textContent==='◆*'`, 'stale identity lock warning');
    character = await jsonFrom(cdp, `/api/character/${characterId}`); if (character.anchors.length !== 1) throw new Error('identity authority silently changed when Character sheet changed');

    await nativeClick(cdp, lockSel);
    await waitFor(cdp, `(async()=>{const r=await (await fetch('/api/character/${characterId}')).json();return r.locked===true&&r.anchors&&r.anchors.length===2})()`, 'explicit identity lock refresh');
    await waitFor(cdp, `document.querySelector(${JSON.stringify(lockSel)})?.classList.contains('stale')===false`, 'fresh identity lock');
    character = await jsonFrom(cdp, `/api/character/${characterId}`);
    const binding = await jsonFrom(cdp, `/api/character/shot/${shotId}`);
    if (!binding.characterIds.includes(characterId) || binding.characters[0].anchors.length !== 2) throw new Error('shot binding did not expose refreshed anchors');

    if (SCREENSHOT) { const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64')); }
    await cdp.send('Page.reload', { ignoreCache: true }); await waitBoot(cdp); await delay(1200); await nativeClick(cdp, tabSel);
    const after = await jsonFrom(cdp, `/api/character/${characterId}`); const afterBinding = await jsonFrom(cdp, `/api/character/shot/${shotId}`);
    if (!after.locked || after.anchors.length !== 2 || !afterBinding.characterIds.includes(characterId)) throw new Error('Character identity/binding did not survive reload');
    await waitFor(cdp, `document.querySelector(${JSON.stringify(lockSel)})?.classList.contains('locked')===true&&document.querySelector(${JSON.stringify(bindSel)})?.classList.contains('bound')===true`, 'rehydrated lock and shot binding UI');
    console.log(JSON.stringify({ ok: true, characterId, shotId, locked: after.locked, anchors: after.anchors.map((a) => a.sha), bound: afterBinding.characterIds }));
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_e) {} child.kill('SIGTERM'); await delay(100); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
  }
}
main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
