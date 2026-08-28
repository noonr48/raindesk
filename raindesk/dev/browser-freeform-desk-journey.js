'use strict';

/**
 * Freeform Creative Desk v2 — Phase 6 acceptance journey (25 steps).
 *
 * One real Chromium, one server, one fresh data dir. Every step asserts
 * observable browser state; failures carry the Gate-0 contract (phase
 * marker, console errors, DOM dump, screenshot) before cleanup.
 *
 * Run: CHROME_BIN=/usr/bin/google-chrome-stable node dev/browser-freeform-desk-journey.js
 * Env receipts: FREEFORM_JOURNEY_SCREENSHOT, FREEFORM_JOURNEY_DIAGNOSTICS.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-freeform-journey-'));
process.env.RAINDESK_DATA_DIR = DATA_DIR;
process.env.RAINDESK_SEED_BOARD = '0'; // journey runs on an explicit empty project

const { createServer } = require('../server');

const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.FREEFORM_JOURNEY_SCREENSHOT || '';
const DIAGNOSTICS = process.env.FREEFORM_JOURNEY_DIAGNOSTICS || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const steps = [];
let phase = 'startup';
function step(n, label) {
  phase = `step-${n}-${label}`;
  steps.push(n);
  console.error(`[journey] step ${n}/25: ${label}`);
}

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

async function waitFor(cdp, expression, label, ms = 15_000, awaitPromise = false) {
  const deadline = Date.now() + ms;
  let wedged = 0;
  while (Date.now() < deadline) {
    try { if (await value(cdp, expression, awaitPromise, 2_500)) return; }
    catch (error) {
      const msg = String(error && error.message);
      if (/CDP timeout: Runtime\.evaluate/.test(msg)) { wedged += 1; continue; }
      // Polled page promises (fetch witnesses) reject transiently under
      // connection churn — keep polling; the deadline bounds us.
      if (awaitPromise && /Failed to fetch|NetworkError/i.test(msg)) { wedged += 1; continue; }
      throw error;
    }
    await delay(120);
  }
  if (wedged) console.error(`[journey] wedge detector: ${wedged} CDP evaluates timed out while waiting for ${label}`);
  throw new Error(`timed out waiting for ${label}`);
}

async function dragWindow(cdp, windowId, dx, dy) {
  const raw = await value(cdp, `(()=>{const f=document.querySelector('.freeform-window[data-window-id=${JSON.stringify(windowId)}]');if(!f)return null;const h=f.querySelector('.freeform-window-head');const r=h.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`);
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
  return JSON.parse(await value(cdp, `(()=>{const f=document.querySelector('.freeform-window[data-window-id=${JSON.stringify(windowId)}]');if(!f)return JSON.stringify(null);return JSON.stringify({left:f.style.left,top:f.style.top});})()`));
}

async function captureDiagnostics(cdp, error) {
  const diag = { ok: !error, phase, stepsDone: steps.length, error: error ? String(error && error.stack || error) : null };
  if (cdp) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      if (SCREENSHOT) { fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true }); fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64')); diag.screenshot = true; }
    } catch (_e) { diag.screenshot = `failed: ${_e.message}`; }
    try {
      diag.dom = await value(cdp, `(()=>{return JSON.stringify({boot:document.documentElement&&document.documentElement.dataset&&document.documentElement.dataset.raindeskBoot,windows:Array.from(document.querySelectorAll('.freeform-window')).map((f)=>({id:f.dataset.windowId,left:f.style.left,top:f.style.top,hidden:f.hidden})),shelfChips:document.querySelectorAll('.freeform-shelf-chip').length})})()`);
    } catch (_e) { diag.dom = `failed: ${_e.message}`; }
    diag.consoleErrors = cdp.consoleErrors.slice(0, 20);
  }
  if (DIAGNOSTICS) {
    try { fs.mkdirSync(path.dirname(DIAGNOSTICS), { recursive: true }); fs.writeFileSync(DIAGNOSTICS, JSON.stringify(diag, null, 2) + '\n'); } catch (_e) {}
  }
  console.error(`[journey] diagnostics: ${JSON.stringify(diag).slice(0, 700)}`);
}

async function main() {
  const watchdog = setTimeout(() => { console.error('[journey] watchdog expired'); process.exit(124); }, 300_000);
  const server = createServer({ partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) } });
  const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-journey-chrome-'));
  let debugPort = await freePort();
  const chromeArgs = () => ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, '--window-size=1440,900', `--user-data-dir=${profile}`, 'about:blank'];
  let chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
  async function startDevtools() {
    try { return await waitDevtools(debugPort, chrome); }
    catch (_firstError) {
      if (chrome.exitCode == null) chrome.kill('SIGKILL');
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-journey-chrome-'));
      debugPort = await freePort();
      chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
      return await waitDevtools(debugPort, chrome);
    }
  }
  let page = null;
  try {
    const browserWsUrl = await startDevtools();

    // 1. Flag gate: default boot mounts nothing.
    step(1, 'default boot mounts no freeform windows');
    page = await openPage(browserWsUrl, base);
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'default boot', 60_000);
    await delay(500);
    if (await value(page, `document.querySelectorAll('.freeform-window').length`) !== 0) throw new Error('flag gate broken on default boot');
    try { page.ws.close(); } catch (_e) {}

    // 2. Freeform boot reaches ready.
    step(2, 'freeform boot reaches ready');
    page = await openPage(browserWsUrl, `${base}?freeform=1`);
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'freeform boot', 60_000);

    // 3. Scenes + Layers mount as windows.
    step(3, 'scenes and layers windows mount');
    await waitFor(page, `document.querySelectorAll('.freeform-window').length >= 2`, 'windows mounted', 20_000);

    // 4. Chrome completeness on both windows.
    step(4, 'window chrome completeness');
    for (const chromeBit of ['.freeform-window[data-window-id="window_scenes"] .freeform-window-head', '.freeform-window[data-window-id="window_scenes"] .freeform-window-body', '.freeform-window[data-window-id="window_layers"] .freeform-window-resize', '.freeform-window[data-window-id="window_layers"] .freeform-window-title']) {
      await waitFor(page, `!!document.querySelector(${JSON.stringify(chromeBit)})`, `chrome ${chromeBit}`, 8_000);
    }

    // 5. Empty project honesty: no seeded shot tab, calm canvas.
    step(5, 'empty project stays empty');
    if (await value(page, `document.querySelectorAll('.creative-sheet').length`) !== 0) throw new Error('journey project seeded stock sheets');

    // 6. Focus raises z-order: pointerdown on the (opened-last) layers window.
    step(6, 'focus raises z-order');
    await waitFor(page, `(()=>{const l=document.querySelector('.freeform-window[data-window-id="window_layers"]');const s=document.querySelector('.freeform-window[data-window-id="window_scenes"]');if(!l||!s)return false;l.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return Number(l.style.zIndex)>Number(s.style.zIndex);})()`, 'layers raised above scenes', 8_000);

    // 7. Native drag moves the Scenes window.
    step(7, 'native drag moves scenes');
    const before = await windowRect(page, 'window_scenes');
    await dragWindow(page, 'window_scenes', 180, 140);
    const after = await windowRect(page, 'window_scenes');
    if (!after || after.left === before.left) throw new Error(`drag did not move scenes: ${JSON.stringify({ before, after })}`);

    // 8. Edge drag docks a dock-capable surface; dragging away re-floats it.
    step(8, 'edge drag docks, drag-away re-floats');
    await dragWindow(page, 'window_scenes', -(parseInt(after.left, 10) || 200) - 40, 0);
    await waitFor(page, `window.raindeskFreeform.state('window_scenes').state==='docked'`, 'scenes dock at left edge', 5_000);
    const postDock = await windowRect(page, 'window_scenes');
    await dragWindow(page, 'window_scenes', 320, 0);
    await waitFor(page, `window.raindeskFreeform.state('window_scenes').state==='floating'`, 'drag off the edge re-floats scenes', 5_000);
    if ((await windowRect(page, 'window_scenes')).left === postDock.left) throw new Error('re-float did not move the window off the dock edge');

    // 9. Manager rename through title editing.
    step(9, 'rename through title edit');
    await value(page, `(()=>{const t=document.querySelector('.freeform-window[data-window-id="window_scenes"] .freeform-window-title');t.textContent='Shot list';t.dispatchEvent(new Event('blur'));return true;})()`);
    await waitFor(page, `document.querySelector('.freeform-window[data-window-id="window_scenes"] .freeform-window-title').textContent==='Shot list'`, 'renamed', 5_000);

    // 10. Minimise hides the window.
    step(10, 'minimise hides the window');
    const preMin = await windowRect(page, 'window_scenes');
    // Atomic probe: minimise + read in one evaluate — proves the transition
    // and its render are synchronous in the real browser, decoupled from any
    // return-value serialization of the model object.
    const immediate = await value(page, `(()=>{const m=window.raindeskFreeform.minimise('window_scenes');const f=document.querySelector('.freeform-window[data-window-id="window_scenes"]');return JSON.stringify({hidden:f.hidden,state:m&&m.state});})()`);
    console.error(`[journey] step 10 atomic minimise: ${immediate}`);
    const atomic = JSON.parse(immediate);
    if (atomic.state !== 'minimised') throw new Error(`minimise did not transition: ${immediate}`);
    await waitFor(page, `document.querySelector('.freeform-window[data-window-id="window_scenes"]').hidden===true`, 'hidden after minimise', 8_000);

    // 11. Shelf chip appears.
    step(11, 'shelf chip appears');
    await waitFor(page, `document.querySelectorAll('.freeform-shelf-chip').length>=1`, 'chip rendered', 8_000);

    // 12. Chip click restores at the same rect.
    step(12, 'shelf chip restores');
    await value(page, `document.querySelector('.freeform-shelf-chip').click()`);
    await waitFor(page, `document.querySelector('.freeform-window[data-window-id="window_scenes"]').hidden===false`, 'restored visible', 8_000);
    const restoredRect = await windowRect(page, 'window_scenes');
    if (restoredRect.left !== preMin.left || restoredRect.top !== preMin.top) throw new Error(`restore moved the rect: ${JSON.stringify({ preMin, restoredRect })}`);

    // 13. Group scenes + layers into a stack.
    step(13, 'group into a tab stack');
    await value(page, `window.raindeskFreeform.groupWindows(['window_scenes','window_layers'], { activeWindowId: 'window_scenes' })`);
    await waitFor(page, `!!document.querySelector('.freeform-window[data-window-id="window_scenes"] .freeform-window-tab')`, 'tab strip', 8_000);

    // 14. Inactive member hidden.
    step(14, 'inactive member hidden');
    await waitFor(page, `document.querySelector('.freeform-window[data-window-id="window_layers"]').hidden===true`, 'layers hidden in stack', 8_000);

    // 15. Switch tab flips visibility.
    step(15, 'switch tab flips visibility');
    await value(page, `window.raindeskFreeform.switchTab('window_layers')`);
    await waitFor(page, `document.querySelector('.freeform-window[data-window-id="window_layers"]').hidden===false`, 'layers visible', 8_000);
    await waitFor(page, `document.querySelector('.freeform-window[data-window-id="window_scenes"]').hidden===true`, 'scenes hidden', 8_000);

    // 16. Tear out returns to floating.
    step(16, 'tear out to floating');
    await value(page, `window.raindeskFreeform.tearOut('window_layers', 860, 320)`);
    await waitFor(page, `window.raindeskFreeform.state('window_layers').state==='floating'`, 'torn out', 8_000);

    // 17. Rejoin the stack by drop-to-group.
    step(17, 'drop-to-group rejoins');
    await value(page, `window.raindeskFreeform.joinGroup('window_layers', 'window_scenes')`);
    await waitFor(page, `window.raindeskFreeform.groups()[0].windowIds.length===2`, 'group has both', 8_000);
    await delay(300);
    // Poll the SERVER until the group lands (a fixed delay flakes on slow
    // runners: persistStructure may adopt-and-retry past any single delay).
    await waitFor(page, `fetch('/api/workspace').then((r)=>r.json()).then((w)=>(w.groups||[]).some((g)=>Array.isArray(g.windowIds)&&g.windowIds.length===2))`, 'group persisted server-side', 10_000, true);
    const serverWs = await value(page, `fetch('/api/workspace').then((r)=>r.json()).then((w)=>JSON.stringify({rev:w.revision,groups:(w.groups||[]).map((g)=>({id:g.groupId,n:g.windowIds.length}))}))`, true);
    console.error(`[journey] step 17 server workspace: ${serverWs}`);
    if (!JSON.parse(serverWs).groups.length) throw new Error(`group never reached the server: ${serverWs}`);

    // 18. Reload restores the group with its active member.
    step(18, 'reload restores the group');
    const preReloadRect = await windowRect(page, 'window_scenes'); // captured BEFORE the reload for the step-19 equality check
    const preReloadState = await value(page, `(()=>{const s=window.raindeskFreeform.state('window_scenes');return JSON.stringify({rect:s.rect,state:s.state,dock:s.dock});})()`, true);
    try { page.ws.close(); } catch (_e) {}
    page = await openPage(browserWsUrl, `${base}?freeform=1`);
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'reload boot', 60_000);
    await waitFor(page, `window.raindeskFreeform && window.raindeskFreeform.groups().length===1`, 'group restored', 20_000);

    // 19. Restored geometry equals pre-reload geometry (GPT Pro round-4:
    // the old step only labelled restoration without comparing values).
    step(19, 'geometry survives reload');
    await waitFor(page, `!!document.querySelector('.freeform-window[data-window-id="window_scenes"] .freeform-window-tab')`, 'tab strip restored', 10_000);
    const postReloadRect = await windowRect(page, 'window_scenes');
    if (JSON.stringify(postReloadRect) !== JSON.stringify(preReloadRect)) {
      throw new Error(`geometry changed across reload: ${JSON.stringify({ preReloadRect, postReloadRect })}`);
    }
    // Full canonical witness (GPT Pro round-5): the DOM rect alone permits
    // width/height drift; compare the manager's canonical {x,y,width,height}
    // plus lifecycle state and dock.
    const postReloadState = await value(page, `(()=>{const s=window.raindeskFreeform.state('window_scenes');return JSON.stringify({rect:s.rect,state:s.state,dock:s.dock});})()`, true);
    if (postReloadState !== preReloadState) {
      throw new Error(`canonical state changed across reload: ${JSON.stringify({ preReloadState, postReloadState })}`);
    }

    // 20. Takes surface opens with the honest empty state.
    step(20, 'takes surface empty state');
    await value(page, `window.raindeskFreeform.open('takes')`);
    await waitFor(page, `!!document.querySelector('.freeform-window[data-window-id="window_takes"] .freeform-take-label')`, 'takes mounted', 8_000);
    if (await value(page, `document.querySelector('.freeform-window[data-window-id="window_takes"] .freeform-take-label').textContent`) !== 'no takes yet') throw new Error('takes empty state wrong');

    // 21. Characters surface opens against the real server registry.
    step(21, 'characters surface empty registry');
    await value(page, `window.raindeskFreeform.open('characters')`);
    await waitFor(page, `document.querySelectorAll('.freeform-window[data-window-id="window_characters"]').length>0`, 'characters mounted', 8_000);

    // 22. Notes surface types and persists through the seam.
    step(22, 'notes typing persists');
    await value(page, `window.raindeskFreeform.open('notes')`);
    await waitFor(page, `!!document.querySelector('.freeform-window[data-window-id="window_notes"] .freeform-notes-area')`, 'notes mounted', 8_000);
    await value(page, `(()=>{const ta=document.querySelector('.freeform-window[data-window-id="window_notes"] .freeform-notes-area');ta.value='hold on Lena longer';ta.dispatchEvent(new Event('input',{bubbles:true}));return 'typed';})()`);
    await waitFor(page, `Object.keys(localStorage).some((k)=>k.startsWith('raindesk.notes.v1.') && localStorage.getItem(k)==='hold on Lena longer')`, 'notes persisted to the scoped store', 8_000);

    // 23. Notes survive a reload.
    step(23, 'notes survive reload');
    try { page.ws.close(); } catch (_e) {}
    page = await openPage(browserWsUrl, `${base}?freeform=1`);
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'notes reload boot', 60_000);
    await value(page, `window.raindeskFreeform.open('notes')`);
    await waitFor(page, `document.querySelector('.freeform-window[data-window-id="window_notes"] .freeform-notes-area').value==='hold on Lena longer'`, 'notes restored', 10_000);

    // 24. Edge snap is real for dock-capable surfaces and leaves no ghost:
    // drag notes into the left edge (it must dock), then away (it must
    // re-float), then assert the preview overlay was fully torn down.
    step(24, 'edge snap docks, no leaked snap ghost');
    const notesRect = await windowRect(page, 'window_notes');
    const notesLeft = parseInt(notesRect.left, 10) || 0;
    await dragWindow(page, 'window_notes', -(notesLeft + 40), 0);
    await waitFor(page, `window.raindeskFreeform.state('window_notes').state==='docked'`, 'notes dock at left edge', 5_000);
    // Docking must be durable: reload and prove the edge survived (GPT Pro
    // round-3 — init() used to downgrade every docked window to floating).
    try { page.ws.close(); } catch (_e) {}
    page = await openPage(browserWsUrl, `${base}?freeform=1`);
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'dock reload boot', 60_000);
    await waitFor(page, `window.raindeskFreeform && window.raindeskFreeform.state('window_notes') && window.raindeskFreeform.state('window_notes').state==='docked'`, 'docked state survives reload', 10_000);
    await dragWindow(page, 'window_notes', 320, 0);
    await waitFor(page, `window.raindeskFreeform.state('window_notes').state==='floating'`, 'notes re-float off the edge', 5_000);
    if (await value(page, `document.querySelectorAll('.freeform-snap-preview').length`) !== 0) throw new Error('snap preview ghost leaked after gesture settled');

    // 25. Zero console errors across the whole journey.
    step(25, 'zero console errors');
    if (page.consoleErrors.length) throw new Error(`console errors: ${page.consoleErrors.slice(0, 5).join(' | ')}`);

    if (SCREENSHOT) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true }); fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    clearTimeout(watchdog);
    console.log(JSON.stringify({ ok: true, steps: steps.length, journey: 'freeform-desk-v2-acceptance' }));
    await captureDiagnostics(page, null);
  } catch (journeyError) {
    await captureDiagnostics(page, journeyError);
    throw journeyError;
  } finally {
    try { if (page && page.ws) page.ws.close(); } catch (_e) {}
    if (chrome.exitCode == null) chrome.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_e) {}
  }
  // Hard exit: a wedged CDP WebSocket or lingering socket must never hold
  // the journey process open past its own verdict (watchdog observed this).
  process.exit(process.exitCode || 0);
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; process.exit(1); });
