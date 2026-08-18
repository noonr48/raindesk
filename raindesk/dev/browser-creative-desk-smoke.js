'use strict';

/** Native Chromium smoke for Creative Desk v1 world-space behavior. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP_URL = process.argv[2] || 'http://127.0.0.1:17600/';
const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.CREATIVE_DESK_SCREENSHOT || '';
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
      const msg = JSON.parse(String(event.data)); if (!msg.id || !this.pending.has(msg.id)) return;
      const p = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {});
    });
  }
  send(method, params = {}) {
    const id = ++this.seq; return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
async function connectPage(browserWsUrl, url) {
  const parsed = new URL(browserWsUrl);
  const made = await fetch(`http://${parsed.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!made.ok) throw new Error(`could not create Chromium page: HTTP ${made.status}`);
  const target = await made.json(); const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
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
async function waitBoot(cdp) { return waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot === 'ready'`, 'Raindesk boot'); }
async function workspace(cdp) {
  const raw = await value(cdp, `(async()=>JSON.stringify(await (await fetch('/api/workspace')).json()))()`); return JSON.parse(raw);
}
function object(ws, id) { return (ws.objects || []).find((o) => o.id === id); }
async function box(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,width:r.width,height:r.height})})()`);
  return raw ? JSON.parse(raw) : null;
}
async function nativeClick(cdp, selector) {
  const r = await box(cdp, selector); if (!r || r.width <= 0 || r.height <= 0) throw new Error(`missing click target ${selector}`);
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = await value(cdp, `(()=>{const t=document.elementFromPoint(${x},${y});const e=document.querySelector(${JSON.stringify(selector)});return !!(t&&e&&(t===e||e.contains(t)))})()`);
  if (!hit) throw new Error(`click target is clipped or obscured: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(250);
}
async function drag(cdp, from, to) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x-from.x)*t, y: from.y + (to.y-from.y)*t, button: 'left', buttons: 1 });
    await delay(35);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(450);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-creative-desk-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server',
    '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const browserWs = await waitForDevtools(child); cdp = await connectPage(browserWs, APP_URL);
    await waitBoot(cdp); await delay(900);
    let ws = await workspace(cdp);
    if (ws.schemaVersion !== 2) throw new Error(`expected workspace v2, got ${ws.schemaVersion}`);
    for (const id of ['world_shot_S01', 'world_character_primary', 'world_references_main']) {
      const obj = object(ws, id); if (!obj || obj.space !== 'world') throw new Error(`missing world object ${id}: ${JSON.stringify(obj)}`);
    }
    for (const id of ['panel_partner', 'panel_layers', 'panel_scenes', 'panel_beats']) {
      const obj = object(ws, id); if (!obj || obj.space !== 'screen') throw new Error(`utility object not screen-space ${id}: ${JSON.stringify(obj)}`);
    }

    const stage = await box(cdp, '#stage'); if (!stage) throw new Error('stage missing');
    const px = stage.x + stage.width * 0.52, py = stage.y + stage.height * 0.48;
    const hit = await value(cdp, `document.elementFromPoint(${px},${py})?.id`);
    if (hit !== 'canvas') throw new Error(`zoom point obscured by ${hit || 'unknown'}`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaY: -240, deltaX: 0 });
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();return w.viewport.zoom>1.1})()`, 'persisted world zoom');
    ws = await workspace(cdp); const zoomed = { ...ws.viewport };

    // Space + native left drag pans the world instead of drawing on the shot.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await drag(cdp, { x: px, y: py }, { x: px + 120, y: py + 70 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();return Math.abs(w.viewport.x-(${zoomed.x}))>80&&Math.abs(w.viewport.y-(${zoomed.y}))>40})()`, 'persisted world pan');

    // Tear the Character tab onto an open portion of the desk.
    const charTab = await box(cdp, '[data-creative-target="world_character_primary"]');
    if (!charTab) throw new Error('Character tab missing');
    const from = { x: charTab.x + charTab.width/2, y: charTab.y + charTab.height/2 };
    const drop = { x: stage.x + stage.width * 0.68, y: stage.y + stage.height * 0.28 };
    await drag(cdp, from, drop);
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();const o=w.objects.find(x=>x.id==='world_character_primary');return o&&o.visible===true&&!o.collapsed})()`, 'torn-out Character canvas');
    ws = await workspace(cdp); const char1 = object(ws, 'world_character_primary');

    const head = await box(cdp, '[data-world-id="world_character_primary"] .creative-sheet-head');
    if (!head) throw new Error('Character sheet did not render');
    // bc77b18 reserves mid-rename title presses (document-capture
    // stopPropagation while contenteditable); at-rest title presses start
    // ordinary header drags. Find a draggable point via the browser's own
    // hit-test: elementFromPoint is the header itself or its resting title.
    const headPt = await value(cdp, `(()=>{const h=document.querySelector('[data-world-id="world_character_primary"] .creative-sheet-head');const r=h.getBoundingClientRect();for(let fx=0.06;fx<=0.94;fx+=0.03){const x=r.left+r.width*fx;const y=r.top+r.height*0.5;const el=document.elementFromPoint(x,y);if(el===h||(el&&el.closest&&el.closest('.creative-sheet-title')&&el.getAttribute('contenteditable')!=='true'))return JSON.stringify({x,y});}return null})()`, false);
    if (!headPt) throw new Error('no draggable header point: head is fully covered by reserved controls');
    const headPress = JSON.parse(headPt);
    await drag(cdp, headPress, { x: headPress.x - 90, y: headPress.y + 65 });
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();const o=w.objects.find(x=>x.id==='world_character_primary');return o&&Math.abs(o.x-(${char1.x}))>25&&Math.abs(o.y-(${char1.y}))>20})()`, 'world sheet drag persistence');
    ws = await workspace(cdp); const char2 = object(ws, 'world_character_primary');

    // Rename gestures still own mid-edit presses (bc77b18 narrowed, not
    // reverted): dblclick opens the title editor; a drag-press INSIDE the open
    // editor must not move the sheet; Escape closes without renaming.
    const titleSel = '[data-world-id="world_character_primary"] .creative-sheet-title';
    const titleBox = await box(cdp, titleSel);
    if (!titleBox) throw new Error('title element missing');
    const titleMid = { x: titleBox.x + titleBox.width / 2, y: titleBox.y + titleBox.height / 2 };
    for (const count of [1, 2]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleMid.x, y: titleMid.y, button: 'left', buttons: 1, clickCount: count });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleMid.x, y: titleMid.y, button: 'left', buttons: 0, clickCount: count });
      await delay(90);
    }
    await waitFor(cdp, `document.querySelector(${JSON.stringify(titleSel)})?.getAttribute('contenteditable')==='true'`, 'title editor open');
    await drag(cdp, titleMid, { x: titleMid.x + 60, y: titleMid.y + 40 });
    const midEdit = await value(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();const o=w.objects.find(x=>x.id==='world_character_primary');return JSON.stringify({x:o.x,y:o.y})})()`);
    const me = JSON.parse(midEdit);
    if (Math.abs(me.x - char2.x) > 1 || Math.abs(me.y - char2.y) > 1) throw new Error(`mid-edit press moved the sheet (reservation broken): ${midEdit} vs ${char2.x},${char2.y}`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await waitFor(cdp, `document.querySelector(${JSON.stringify(titleSel)})?.getAttribute('contenteditable')!=='true'`, 'title editor closed');

    // A normal References tab click reveals and focuses the sheet.
    await nativeClick(cdp, '[data-creative-target="world_references_main"]');
    await waitFor(cdp, `(async()=>{const w=await (await fetch('/api/workspace')).json();const o=w.objects.find(x=>x.id==='world_references_main');return o&&o.visible===true})()`, 'References canvas visible');
    await delay(500); ws = await workspace(cdp); const finalViewport = { ...ws.viewport };

    if (SCREENSHOT) await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then((r) => fs.writeFileSync(SCREENSHOT, Buffer.from(r.data, 'base64')));

    await cdp.send('Page.reload', { ignoreCache: true }); await waitBoot(cdp); await delay(900);
    const after = await workspace(cdp); const afterChar = object(after, 'world_character_primary'); const afterRef = object(after, 'world_references_main');
    if (!afterChar || !afterChar.visible || Math.abs(afterChar.x-char2.x)>0.001 || Math.abs(afterChar.y-char2.y)>0.001) throw new Error('Character world placement did not survive reload');
    if (!afterRef || !afterRef.visible) throw new Error('References visibility did not survive reload');
    if (Math.abs(after.viewport.x-finalViewport.x)>0.001 || Math.abs(after.viewport.y-finalViewport.y)>0.001 || Math.abs(after.viewport.zoom-finalViewport.zoom)>0.001) throw new Error('world viewport did not survive reload');

    console.log(JSON.stringify({ ok:true, viewport:after.viewport, character:{ x:afterChar.x,y:afterChar.y,visible:afterChar.visible }, references:{ x:afterRef.x,y:afterRef.y,visible:afterRef.visible }, schemaVersion:after.schemaVersion }));
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_e) {}
    child.kill('SIGTERM'); await delay(100); try { fs.rmSync(profile, { recursive:true, force:true }); } catch (_e) {}
  }
}
main().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
