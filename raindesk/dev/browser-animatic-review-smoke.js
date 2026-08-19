'use strict';

/** Native Chromium proof: restored pacing -> Preview this -> Take -> Keep -> reload. */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-browser-v2-'));
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-projects-v2-'));
process.env.RAINDESK_DATA_DIR = DATA_DIR;

const Canvas = require('../public/js/canvas');
const blobs = require('../lib/blobs');
const docs = require('../lib/shot-documents');
const direction = require('../lib/direction');
const ledger = require('../lib/partner-invocation-ledger');
const pacingContexts = require('../lib/animatic-pacing-context');
const pacing = require('../lib/animatic-pacing-proposals');
const review = require('../lib/animatic-review-decisions');
const { createServer } = require('../server');

const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.ANIMATIC_PACING_SCREENSHOT || '';
const RECEIPT = process.env.ANIMATIC_PACING_RECEIPT || '';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeExecutor = path.join(DATA_DIR, 'fake-animatic-executor');
const spawnCounter = path.join(DATA_DIR, 'executor-spawns.txt');

fs.writeFileSync(fakeExecutor, `#!/usr/bin/env node
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const arg=(n)=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:null};
const snapshot=JSON.parse(fs.readFileSync(arg('--snapshot'),'utf8'));const out=arg('--out-dir');
if(process.env.FAKE_COUNTER_FILE)fs.appendFileSync(process.env.FAKE_COUNTER_FILE,'spawn\\n');
const attemptId='att-browser-v2',candidateId='cand-browser-v2',runDir=path.join(out,attemptId);
fs.mkdirSync(path.join(runDir,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(runDir,'source-snapshot.json'),JSON.stringify(snapshot,null,2));
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(48,11)]);
const mp4Path=path.join(runDir,'artifacts','animatic.mp4');fs.writeFileSync(mp4Path,mp4);
const sha=crypto.createHash('sha256').update(mp4).digest('hex');
const attempt={schema_version:'0.2.0',attempt_id:attemptId,source_snapshot_digest:snapshot.snapshot_digest,adapter_id:'animatic_timing_v1',adapter_version:'0.2.0',engine:{engine_id:'fake-browser-v2'},lifecycle:'succeeded',terminal_status:'succeeded',started_at:new Date().toISOString(),ended_at:new Date().toISOString(),error:null,candidate_refs:[candidateId],extensions:{}};
const frames=snapshot.shots.reduce((n,s)=>n+s.duration_frames,0);
const candidate={schema_version:'0.2.0',candidate_id:candidateId,sequence_id:snapshot.sequence_id,project_id:snapshot.project_id,attempt_id:attemptId,source_snapshot_digest:snapshot.snapshot_digest,fidelity:{level:snapshot.fidelity,note:'native browser proof'},files:[{path:'artifacts/animatic.mp4',sha256:sha,bytes:mp4.length,mime_type:'video/mp4'}],media:{width:snapshot.width,height:snapshot.height,fps_num:snapshot.fps_num,fps_den:snapshot.fps_den,duration:{num:frames*snapshot.fps_den,den:snapshot.fps_num},alpha:false},provenance:{created_at:new Date().toISOString(),tool:'fake-browser-v2'},rights:{license:'internal',owner:'test',source_rights:'browser-test-rights'},extensions:{}};
fs.writeFileSync(path.join(runDir,'execution-attempt.json'),JSON.stringify(attempt,null,2));
fs.writeFileSync(path.join(runDir,'sequence-candidate.json'),JSON.stringify(candidate,null,2));
console.log(JSON.stringify({ok:true,attempt_id:attemptId,candidate_id:candidateId,run_dir:runDir,mp4:mp4Path}));
`, { mode: 0o755 });
fs.chmodSync(fakeExecutor, 0o755);

function seedProposal() {
  const shotId = 'S01';
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) rgba.set([74, 104, 132, 255], i * 4);
  const asset = blobs.putPng(Buffer.from(Canvas.encodePNG(64, 64, rgba)));
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 64, height: 64 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'native animatic proof' });
  direction.ensureLegacyShot(shotId, { title: 'Wide descent', beat: 'Lena notices the wheel slipping.' });
  const parentId = 'invoke_browser_review_v2';
  ledger.record({
    id: parentId, requestId: parentId, origin: 'partner_server', turnId: 'turn_browser_review_v2', shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing', stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'], expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'], sideEffects: ['creates_animatic_candidate'], status: 'proposed',
  });
  const context = pacingContexts.create({ parentRequestId: parentId, env: { RAINDESK_ANIMATIC_FPS_NUM: '24', RAINDESK_ANIMATIC_FPS_DEN: '1' } }).context;
  return pacing.createFromContext({
    contextDigest: context.contextDigest,
    proposal: { label: 'Restrained', rationale: 'Let the realization land before the cut.', fidelity: 'draft', shots: [{ shotId, durationFrames: 72, note: 'hold on Lena' }] },
  }).proposal;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.unref(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close((e) => e ? reject(e) : resolve(port)); });
  });
}

async function waitDevtools(port, child, ms = 25_000) {
  let stderr = ''; let exitCode = null;
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  child.once('exit', (code) => { exitCode = code; });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (exitCode != null) throw new Error(`Chromium exited early (${exitCode})\n${stderr}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) { const body = await res.json(); if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl; }
    } catch (_e) {}
    await delay(100);
  }
  throw new Error(`Chromium DevTools did not start\n${stderr}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)); const item = this.pending.get(msg.id);
      if (!item) return; this.pending.delete(msg.id); clearTimeout(item.timer);
      if (msg.error) item.reject(new Error(msg.error.message)); else item.resolve(msg.result || {});
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 12_000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connectPage(browserWsUrl, url) {
  const browser = new URL(browserWsUrl);
  const created = await fetch(`http://${browser.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!created.ok) throw new Error(`could not create Chromium page: ${created.status}`);
  const target = await created.json(); const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  return new CDP(ws);
}

async function value(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await value(cdp, expression)) return; await delay(120); }
  throw new Error(`timed out waiting for ${label}`);
}

async function nativeClick(cdp, selector) {
  await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e)e.scrollIntoView({block:'center',inline:'center'});return !!e})()`);
  await delay(120);
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();for(const [fx,fy] of [[.5,.5],[.3,.5],[.7,.5],[.5,.3],[.5,.7]]){const x=r.left+r.width*fx,y=r.top+r.height*fy,h=document.elementFromPoint(x,y);if(h&&(h===e||e.contains(h)))return JSON.stringify({x,y});}return null})()`);
  if (!raw) throw new Error(`native click target not exposed: ${selector}`);
  const point = JSON.parse(raw);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(250);
}

async function main() {
  const watchdog = setTimeout(() => { console.error('[animatic-browser-v2] watchdog expired'); process.exit(124); }, 100_000);
  const proposal = seedProposal();
  const server = createServer({
    partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) },
    sourceRights: 'browser-test-rights',
    animaticEnv: {
      RAINDESK_ANIMATIC_EXECUTOR: fakeExecutor, RAINDESK_ANIMATIC_PROJECT_ROOT: PROJECT_ROOT,
      RAINDESK_SOURCE_RIGHTS: 'browser-test-rights', RAINDESK_ANIMATIC_TIMEOUT_MS: '10000', FAKE_COUNTER_FILE: spawnCounter,
    },
  });
  const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-chromium-v2-'));
  const debugPort = await freePort();
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, '--window-size=1440,900', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    cdp = await connectPage(await waitDevtools(debugPort, chrome), `http://127.0.0.1:${server.address().port}/`);
    await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'Raindesk boot');
    // Desktop workspace opens Partner during async init; wait for the actual creative offer rather than clicking a hidden mobile handle/tab prematurely.
    await waitFor(cdp, `!!document.querySelector('.animatic-pacing-card')`, 'restored pacing card');
    if (!(await value(cdp, `document.querySelector('.animatic-pacing-card')?.textContent?.includes('Restrained')`))) throw new Error('Restrained pacing card missing');

    await nativeClick(cdp, '.animatic-preview-btn');
    await waitFor(cdp, `!!document.querySelector('.animatic-take-card video')`, 'playable Take', 25_000);
    await waitFor(cdp, `document.querySelector('.animatic-take-card video')?.getAttribute('src')?.startsWith('/api/animatic/artifact/')`, 'same-origin MP4');
    await nativeClick(cdp, '.animatic-take-card .animatic-review-btn.keep');
    await waitFor(cdp, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'Keep state');

    const decisions = review.list({ candidateId: 'cand-browser-v2' });
    if (decisions.length !== 1 || decisions[0].decision !== 'keep' || decisions[0].actor_role !== 'owner') throw new Error('durable owner Keep missing');
    if (fs.readFileSync(spawnCounter, 'utf8').trim().split('\n').length !== 1) throw new Error('executor spawned more than once');

    await cdp.send('Page.reload', { ignoreCache: true });
    await delay(1800);
    await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'reload boot');
    await waitFor(cdp, `!!document.querySelector('.animatic-pacing-card')`, 'pacing card after reload');
    await waitFor(cdp, `!!document.querySelector('[data-tab="gens"]')`, 'Takes tab after reload');
    await nativeClick(cdp, '[data-tab="gens"]');
    await waitFor(cdp, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'Keep state after reload');

    if (SCREENSHOT) { const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); fs.writeFileSync(SCREENSHOT, Buffer.from(image.data, 'base64')); }
    const receipt = { ok: true, proposalDigest: proposal.proposalDigest, candidateId: 'cand-browser-v2', reviewDecisionId: decisions[0].decision_id, executorSpawns: 1, reloadRestored: true };
    if (RECEIPT) fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_e) {}
    if (chrome.exitCode == null) chrome.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    for (const dir of [profile, DATA_DIR, PROJECT_ROOT]) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    clearTimeout(watchdog);
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
