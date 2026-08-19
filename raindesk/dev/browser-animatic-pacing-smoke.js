'use strict';

/** Native Chromium proof for pacing proposal -> Preview this -> Take -> Keep -> reload. */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-browser-'));
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-browser-projects-'));
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
const fakeExecutor = path.join(DATA_DIR, 'fake-animatic-browser-executor');
const spawnCounter = path.join(DATA_DIR, 'executor-spawns.txt');

fs.writeFileSync(fakeExecutor, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const snapshotFile = arg('--snapshot');
const outDir = arg('--out-dir');
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
if (process.env.FAKE_COUNTER_FILE) fs.appendFileSync(process.env.FAKE_COUNTER_FILE, 'spawn\\n');
const attemptId = 'att-browser-preview';
const candidateId = 'cand-browser-preview';
const runDir = path.join(outDir, attemptId);
fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'source-snapshot.json'), JSON.stringify(snapshot, null, 2));
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(48, 9)]);
const mp4Path = path.join(runDir, 'artifacts', 'animatic.mp4');
fs.writeFileSync(mp4Path, mp4);
const sha = crypto.createHash('sha256').update(mp4).digest('hex');
const attempt = {
  schema_version:'0.2.0', attempt_id:attemptId, source_snapshot_digest:snapshot.snapshot_digest,
  adapter_id:'animatic_timing_v1', adapter_version:'0.2.0', engine:{engine_id:'fake-browser'},
  lifecycle:'succeeded', terminal_status:'succeeded', started_at:new Date().toISOString(), ended_at:new Date().toISOString(),
  error:null, candidate_refs:[candidateId], extensions:{}
};
const frames = snapshot.shots.reduce((sum, shot) => sum + shot.duration_frames, 0);
const candidate = {
  schema_version:'0.2.0', candidate_id:candidateId, sequence_id:snapshot.sequence_id, project_id:snapshot.project_id,
  attempt_id:attemptId, source_snapshot_digest:snapshot.snapshot_digest,
  fidelity:{level:snapshot.fidelity,note:'native browser fake'},
  files:[{path:'artifacts/animatic.mp4',sha256:sha,bytes:mp4.length,mime_type:'video/mp4'}],
  media:{width:snapshot.width,height:snapshot.height,fps_num:snapshot.fps_num,fps_den:snapshot.fps_den,
    duration:{num:frames * snapshot.fps_den,den:snapshot.fps_num},alpha:false},
  provenance:{created_at:new Date().toISOString(),tool:'fake-browser'},
  rights:{license:'internal',owner:'test',source_rights:'browser-test-rights'},extensions:{}
};
fs.writeFileSync(path.join(runDir, 'execution-attempt.json'), JSON.stringify(attempt, null, 2));
fs.writeFileSync(path.join(runDir, 'sequence-candidate.json'), JSON.stringify(candidate, null, 2));
console.log(JSON.stringify({ok:true,attempt_id:attemptId,candidate_id:candidateId,run_dir:runDir,mp4:mp4Path}));
`, { mode: 0o755 });
fs.chmodSync(fakeExecutor, 0o755);

function solidPng() {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4;
    data[i] = 55 + (x % 70); data[i + 1] = 80 + (y % 80); data[i + 2] = 110; data[i + 3] = 255;
  }
  return Buffer.from(Canvas.encodePNG(64, 64, data));
}

function seed() {
  const shotId = 'S01';
  const asset = blobs.putPng(solidPng());
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 64, height: 64 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'native animatic browser proof' });
  direction.ensureLegacyShot(shotId, { title: 'Wide descent', beat: 'Lena notices the wheel slipping.' });
  const parentId = 'invoke_browser_animatic';
  ledger.record({
    id: parentId, requestId: parentId, origin: 'partner_server', turnId: 'turn_browser_animatic', shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing', stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'], expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'], sideEffects: ['creates_animatic_candidate'], status: 'proposed',
  });
  const context = pacingContexts.create({ parentRequestId: parentId, env: { RAINDESK_ANIMATIC_FPS_NUM: '24', RAINDESK_ANIMATIC_FPS_DEN: '1' } }).context;
  return pacing.createFromContext({
    contextDigest: context.contextDigest,
    proposal: {
      label: 'Restrained', rationale: 'Let the realization land before the cut.', fidelity: 'draft',
      shots: [{ shotId, durationFrames: 72, note: 'hold on Lena' }],
    },
  }).proposal;
}

function waitForDevtools(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chromium DevTools did not start')), ms);
    child.stderr.on('data', (d) => {
      buf += d.toString('utf8');
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buf);
      if (match) { clearTimeout(timer); resolve(match[1]); }
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
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
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
async function exposedPoint(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return h&&(h===e||e.contains(h))?JSON.stringify({x,y}):null})()`);
  return raw ? JSON.parse(raw) : null;
}
async function nativeClick(cdp, selector) {
  const point = await exposedPoint(cdp, selector);
  if (!point) throw new Error(`click target missing, clipped or obscured: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(250);
}

async function main() {
  const proposal = seed();
  const animaticEnv = {
    RAINDESK_ANIMATIC_EXECUTOR: fakeExecutor,
    RAINDESK_ANIMATIC_PROJECT_ROOT: PROJECT_ROOT,
    RAINDESK_SOURCE_RIGHTS: 'browser-test-rights',
    RAINDESK_ANIMATIC_TIMEOUT_MS: '10000',
    FAKE_COUNTER_FILE: spawnCounter,
  };
  const server = createServer({
    partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) },
    sourceRights: 'browser-test-rights', animaticEnv,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-chrome-'));
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--window-size=1440,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp;
  try {
    cdp = await connectPage(await waitForDevtools(child), base);
    await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot === 'ready'`, 'Raindesk boot');
    await delay(700);
    await nativeClick(cdp, '#drawerHandle');
    await waitFor(cdp, `!!document.querySelector('.animatic-pacing-card')`, 'restored pacing proposal');
    const shownDigest = await value(cdp, `document.querySelector('.animatic-pacing-card')?.textContent?.includes('Restrained')`);
    if (!shownDigest) throw new Error('expected Restrained pacing card not shown');
    await nativeClick(cdp, '.animatic-preview-btn');
    await waitFor(cdp, `!!document.querySelector('.animatic-take-card video')`, 'playable animatic Take', 20000);
    await waitFor(cdp, `document.querySelector('.animatic-take-card video')?.getAttribute('src')?.startsWith('/api/animatic/artifact/')`, 'same-origin artifact video');
    await nativeClick(cdp, '.animatic-take-card .animatic-review-btn.keep');
    await waitFor(cdp, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'kept review state');

    const decisions = review.list({ candidateId: 'cand-browser-preview' });
    if (decisions.length !== 1 || decisions[0].decision !== 'keep' || decisions[0].actor_role !== 'owner') {
      throw new Error('owner Keep ReviewDecision was not durably recorded');
    }
    if (fs.readFileSync(spawnCounter, 'utf8').trim().split('\n').length !== 1) throw new Error('preview spawned executor more than once');

    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(cdp, `document.documentElement?.dataset?.raindeskBoot === 'ready'`, 'Raindesk reload');
    await delay(800);
    await nativeClick(cdp, '#drawerHandle');
    await waitFor(cdp, `!!document.querySelector('.animatic-pacing-card')`, 'pacing proposal after reload');
    await nativeClick(cdp, '[data-tab="gens"]');
    await waitFor(cdp, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'review state after reload');

    if (SCREENSHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
    }
    const receipt = {
      ok: true,
      proposalDigest: proposal.proposalDigest,
      candidateId: 'cand-browser-preview',
      reviewDecisionId: decisions[0].decision_id,
      executorSpawns: 1,
      reloadRestored: true,
    };
    if (RECEIPT) fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  } finally {
    if (cdp && cdp.ws) try { cdp.ws.close(); } catch (_e) {}
    child.kill('SIGTERM');
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_e) {}
    try { fs.rmSync(PROJECT_ROOT, { recursive: true, force: true }); } catch (_e) {}
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
