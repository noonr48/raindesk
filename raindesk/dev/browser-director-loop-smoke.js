'use strict';

/**
 * Native Chromium smoke for Director Loop v1.
 *
 * Proves the creative journey, not source strings:
 *  - add a raw Beat through the visible Beat Trail
 *  - DIRECT arrow attaches to that selected Beat
 *  - pin shot + beat visual frame references from the actual art surface
 *  - keep/change boundaries persist
 *  - add/reorder a second beat
 *  - reload and recover the directing structure
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

async function waitFor(cdp, expression, label, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await value(cdp, expression)) return true;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitBoot(cdp) {
  return waitFor(cdp, `document.documentElement && document.documentElement.getAttribute('data-raindesk-boot') === 'ready'`, 'Raindesk boot');
}

async function box(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,width:r.width,height:r.height})})()`);
  return raw ? JSON.parse(raw) : null;
}

async function clickSelector(cdp, selector) {
  const r = await box(cdp, selector);
  if (!r || r.width <= 0 || r.height <= 0) throw new Error(`click target missing: ${selector}`);
  const x = r.x + r.width / 2; const y = r.y + r.height / 2;
  const exposed = await value(cdp, `(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target)return false;const hit=document.elementFromPoint(${x},${y});return !!hit&&(hit===target||target.contains(hit))})()`);
  if (!exposed) throw new Error(`click target is clipped or obscured: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(120);
}

async function inputText(cdp, selector, text, enter = false) {
  const ok = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  if (!ok) throw new Error(`input missing: ${selector}`);
  await cdp.send('Input.insertText', { text });
  if (enter) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  await delay(100);
}

async function dragPath(cdp, points) {
  const first = points[0]; const last = points[points.length - 1];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
    await delay(35);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(180);
}

async function directionGraph(cdp) {
  const raw = await value(cdp, `(async()=>JSON.stringify(await (await fetch('/api/direction')).json()))()`);
  return JSON.parse(raw);
}

async function shotSpec(cdp, shotId) {
  const raw = await value(cdp, `(async()=>JSON.stringify(await (await fetch('/api/direction/shot/${shotId}/spec')).json()))()`);
  return JSON.parse(raw);
}

function visibleBeats(spec) {
  return (spec.beats || []).filter((b) => b.status !== 'rejected').sort((a, b) => a.order - b.order);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-director-loop-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-proxy-server',
    '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    const browserWs = await waitForDevtools(child);
    cdp = await connectPage(browserWs, APP_URL);
    await waitBoot(cdp); await delay(900);

    // Open the real Beat Trail from the visible toolbar.
    await clickSelector(cdp, '[data-tool="beats"]');
    await waitFor(cdp, `document.getElementById('beatTrail').classList.contains('open')`, 'Beat Trail open');

    // Pin raw wording first through the artist-facing field.
    await inputText(cdp, '#beatTrail .beat-trail-input', 'she catches his wrist and he twists his shoulder away');
    await clickSelector(cdp, '#beatTrail .beat-trail-add');
    await waitFor(cdp, `document.querySelectorAll('#beatTrail .beat-row').length === 1`, 'first beat');
    await delay(500);

    let graph = await directionGraph(cdp);
    const shot = graph.shots.find((s) => s.source && s.source.legacyShotId === 'S01') || graph.shots.find((s) => s.id === 'S01');
    if (!shot) throw new Error('legacy S01 direction shot was not created');
    let spec = await shotSpec(cdp, shot.id);
    let beats = visibleBeats(spec);
    if (beats.length !== 1) throw new Error(`expected one visible beat, got ${JSON.stringify(beats)}`);
    const firstBeatId = beats[0].id;
    if (!/catches his wrist/.test(beats[0].rawDirection)) throw new Error('raw Beat Trail wording was not preserved');

    // Draw DIRECT on the selected beat through native pointer input. Global
    // drawing tools stay above floating utility panels; the stroke itself is
    // deliberately placed on exposed art rather than underneath Beat Trail.
    await clickSelector(cdp, '[data-tool="direction"]');
    await waitFor(cdp, `document.querySelector('[data-tool="direction"]').classList.contains('active') && document.getElementById('canvas').classList.contains('direction-cursor')`, 'DIRECT tool active');
    const canvas = await box(cdp, '#canvas');
    if (!canvas) throw new Error('canvas missing');
    const directPoints = [
      { x: canvas.x + canvas.width * 0.57, y: canvas.y + canvas.height * 0.47 },
      { x: canvas.x + canvas.width * 0.63, y: canvas.y + canvas.height * 0.43 },
      { x: canvas.x + canvas.width * 0.69, y: canvas.y + canvas.height * 0.40 },
    ];
    const hit = await value(cdp, `(()=>{const e=document.elementFromPoint(${directPoints[0].x},${directPoints[0].y});return e&&e.id})()`);
    if (hit !== 'canvas') throw new Error(`DIRECT start point is obscured by ${hit || 'unknown element'}`);
    await dragPath(cdp, directPoints);
    await waitFor(cdp, `document.getElementById('directionCaption').classList.contains('open')`, 'direction caption');
    await inputText(cdp, '#directionCaptionInput', 'her hand curves in and lands on his wrist');
    await clickSelector(cdp, '#directionCaptionSave');
    await waitFor(cdp, `(async()=>{const g=await (await fetch('/api/direction')).json();return (g.annotations||[]).some(a=>a.scopeType==='beat'&&a.scopeId===${JSON.stringify(firstBeatId)})})()`, 'beat-scoped DIRECT annotation', 90000);

    // Pin actual art references: shot start and the beat's start/end poses.
    await clickSelector(cdp, '#beatTrail .shot-frame-strip [data-frame-slot="start"] .shot-frame-set');
    await waitFor(cdp, `(async()=>{const s=await (await fetch('/api/direction/shot/${shot.id}/spec')).json();return !!(s.shot&&s.shot.startFrame&&s.shot.startFrame.referenceId)})()`, 'shot start frame', 15000);
    await waitFor(cdp, `!document.getElementById('beatTrail').classList.contains('busy')`, 'shot frame UI ready');
    await clickSelector(cdp, `#beatTrail .active-beat-detail[data-beat-id="${firstBeatId}"] [data-frame-slot="start"] .shot-frame-set`);
    await waitFor(cdp, `(async()=>{const s=await (await fetch('/api/direction/shot/${shot.id}/spec')).json();const b=(s.beats||[]).find(x=>x.id===${JSON.stringify(firstBeatId)});return !!(b&&b.startFrame&&b.startFrame.referenceId)})()`, 'beat start pose', 15000);
    await waitFor(cdp, `!document.getElementById('beatTrail').classList.contains('busy')`, 'beat start UI ready');
    await clickSelector(cdp, `#beatTrail .active-beat-detail[data-beat-id="${firstBeatId}"] [data-frame-slot="end"] .shot-frame-set`);
    await waitFor(cdp, `(async()=>{const s=await (await fetch('/api/direction/shot/${shot.id}/spec')).json();const b=(s.beats||[]).find(x=>x.id===${JSON.stringify(firstBeatId)});return !!(b&&b.endFrame&&b.endFrame.referenceId)})()`, 'beat end pose', 15000);
    await waitFor(cdp, `!document.getElementById('beatTrail').classList.contains('busy')`, 'beat end UI ready');

    // Natural keep/change boundaries.
    await inputText(cdp, '#beatTrail .constraint-row.preserve .constraint-input', 'face identity', true);
    await waitFor(cdp, `(async()=>{const s=await (await fetch('/api/direction/shot/${shot.id}/spec')).json();return (s.shot.preserve||[]).includes('face identity')})()`, 'keep constraint');
    await inputText(cdp, '#beatTrail .constraint-row.change .constraint-input', 'right hand pose', true);
    await waitFor(cdp, `(async()=>{const s=await (await fetch('/api/direction/shot/${shot.id}/spec')).json();return (s.shot.change||[]).includes('right hand pose')})()`, 'change constraint');

    // Add a second raw beat and move it earlier using the tiny beat controls.
    await inputText(cdp, '#beatTrail .beat-trail-input', 'camera pushes inward as he speaks');
    await clickSelector(cdp, '#beatTrail .beat-trail-add');
    await waitFor(cdp, `document.querySelectorAll('#beatTrail .beat-row').length === 2`, 'second beat');
    spec = await shotSpec(cdp, shot.id); beats = visibleBeats(spec);
    const secondBeatId = beats.find((b) => b.id !== firstBeatId).id;
    await clickSelector(cdp, `#beatTrail .beat-row[data-beat-id="${secondBeatId}"] .beat-row-btn[title="earlier"]`);
    await waitFor(cdp, `(async()=>{const s=await (await fetch('/api/direction/shot/${shot.id}/spec')).json();const b=(s.beats||[]).filter(x=>x.status!=='rejected').sort((a,b)=>a.order-b.order);return b[0]&&b[0].id===${JSON.stringify(secondBeatId)}})()`, 'beat reorder');

    spec = await shotSpec(cdp, shot.id);
    const annotation = (spec.annotations || []).find((a) => a.scopeType === 'beat' && a.scopeId === firstBeatId);
    const first = (spec.beats || []).find((b) => b.id === firstBeatId);
    if (!annotation) throw new Error('DIRECT annotation missing from shot spec');
    if (!first.startFrame || !first.endFrame) throw new Error('beat pose refs missing before reload');
    if (!first.startFrame.sourceRevisionId) throw new Error('beat frame did not retain art revision provenance');

    // Reload the entire application: semantic directing state must still exist.
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitBoot(cdp); await delay(900);
    const after = await shotSpec(cdp, shot.id);
    const afterBeats = visibleBeats(after);
    const afterFirst = after.beats.find((b) => b.id === firstBeatId);
    if (afterBeats[0].id !== secondBeatId) throw new Error('beat order did not survive reload');
    if (!(after.annotations || []).some((a) => a.scopeType === 'beat' && a.scopeId === firstBeatId)) throw new Error('beat-scoped DIRECT mark did not survive reload');
    if (!afterFirst.startFrame || !afterFirst.endFrame) throw new Error('beat frame refs did not survive reload');
    if (!(after.shot.preserve || []).includes('face identity')) throw new Error('keep constraint did not survive reload');
    if (!(after.shot.change || []).includes('right hand pose')) throw new Error('change constraint did not survive reload');

    // Leave a useful acceptance view behind: reopen Beats if needed and focus
    // the annotated beat so CI screenshots show the actual directing surface.
    const beatsOpen = Boolean(await value(cdp, `document.getElementById('beatTrail').classList.contains('open')`));
    if (!beatsOpen) await clickSelector(cdp, '[data-tool="beats"]');
    await waitFor(cdp, `document.getElementById('beatTrail').classList.contains('open')`, 'Beat Trail acceptance view');
    await clickSelector(cdp, `#beatTrail .beat-row[data-beat-id="${firstBeatId}"]`);
    await delay(350);
    if (process.env.DIRECTOR_LOOP_SCREENSHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.mkdirSync(path.dirname(process.env.DIRECTOR_LOOP_SCREENSHOT), { recursive: true });
      fs.writeFileSync(process.env.DIRECTOR_LOOP_SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }

    console.log(JSON.stringify({
      ok: true,
      shotId: shot.id,
      beatOrder: afterBeats.map((b) => b.id),
      annotatedBeatId: firstBeatId,
      annotationKind: annotation.kind,
      shotStart: after.shot.startFrame.referenceId,
      beatStart: afterFirst.startFrame.referenceId,
      beatEnd: afterFirst.endFrame.referenceId,
      preserve: after.shot.preserve,
      change: after.shot.change,
    }));
  } finally {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (_e) {}
    try { child.kill('SIGKILL'); } catch (_e) {}
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
