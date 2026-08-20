'use strict';

/**
 * Native Chromium proof for the first artist-facing animatic loop.
 *
 * It uses a fresh same-browser page for the reload half of the proof. That
 * avoids GitHub-runner CDP renderer-swap flakiness while proving the stronger
 * product property: a brand-new document reconstructs pacing, Takes and Keep
 * state from durable server authority rather than page memory.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-reload-'));
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-projects-'));
process.env.RAINDESK_DATA_DIR = DATA_DIR;

const Canvas = require('../public/js/canvas');
const blobs = require('../lib/blobs');
const docs = require('../lib/shot-documents');
const direction = require('../lib/direction');
const ledger = require('../lib/partner-invocation-ledger');
const contexts = require('../lib/animatic-pacing-context');
const pacing = require('../lib/animatic-pacing-proposals');
const review = require('../lib/animatic-review-decisions');
const { createServer } = require('../server');

const CHROME = process.env.CHROME_BIN || process.env.BROWSER || 'chromium';
const SCREENSHOT = process.env.ANIMATIC_PACING_SCREENSHOT || '';
const RECEIPT = process.env.ANIMATIC_PACING_RECEIPT || '';
const DIAGNOSTICS = process.env.ANIMATIC_PACING_DIAGNOSTICS
  || (RECEIPT ? path.join(path.dirname(RECEIPT), 'pacing-review-diagnostics.json') : '');
let phase = 'startup';
const fakeExecutor = path.join(DATA_DIR, 'fake-animatic-reload-executor');
const spawnCounter = path.join(DATA_DIR, 'executor-spawns.txt');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.writeFileSync(fakeExecutor, `#!/usr/bin/env node
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const arg=(name)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null};
const snapshot=JSON.parse(fs.readFileSync(arg('--snapshot'),'utf8'));const out=arg('--out-dir');
if(process.env.FAKE_COUNTER_FILE)fs.appendFileSync(process.env.FAKE_COUNTER_FILE,'spawn\\n');
const attemptId='att-browser-reload',candidateId='cand-browser-reload',runDir=path.join(out,attemptId);
fs.mkdirSync(path.join(runDir,'artifacts'),{recursive:true});
fs.writeFileSync(path.join(runDir,'source-snapshot.json'),JSON.stringify(snapshot,null,2));
const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(48,13)]);
const mp4Path=path.join(runDir,'artifacts','animatic.mp4');fs.writeFileSync(mp4Path,mp4);
const sha=crypto.createHash('sha256').update(mp4).digest('hex');
const attempt={schema_version:'0.2.0',attempt_id:attemptId,source_snapshot_digest:snapshot.snapshot_digest,adapter_id:'animatic_timing_v1',adapter_version:'0.2.0',engine:{engine_id:'fake-browser-reload'},lifecycle:'succeeded',terminal_status:'succeeded',started_at:new Date().toISOString(),ended_at:new Date().toISOString(),error:null,candidate_refs:[candidateId],extensions:{}};
const frames=snapshot.shots.reduce((sum,shot)=>sum+shot.duration_frames,0);
const candidate={schema_version:'0.2.0',candidate_id:candidateId,sequence_id:snapshot.sequence_id,project_id:snapshot.project_id,attempt_id:attemptId,source_snapshot_digest:snapshot.snapshot_digest,fidelity:{level:snapshot.fidelity,note:'native browser reload proof'},files:[{path:'artifacts/animatic.mp4',sha256:sha,bytes:mp4.length,mime_type:'video/mp4'}],media:{width:snapshot.width,height:snapshot.height,fps_num:snapshot.fps_num,fps_den:snapshot.fps_den,duration:{num:frames*snapshot.fps_den,den:snapshot.fps_num},alpha:false},provenance:{created_at:new Date().toISOString(),tool:'fake-browser-reload'},rights:{license:'internal',owner:'test',source_rights:'browser-test-rights'},extensions:{}};
fs.writeFileSync(path.join(runDir,'execution-attempt.json'),JSON.stringify(attempt,null,2));
fs.writeFileSync(path.join(runDir,'sequence-candidate.json'),JSON.stringify(candidate,null,2));
console.log(JSON.stringify({ok:true,attempt_id:attemptId,candidate_id:candidateId,run_dir:runDir,mp4:mp4Path}));
`, { mode: 0o755 });
fs.chmodSync(fakeExecutor, 0o755);

function seedProposal() {
  const shotId = 'S01';
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) rgba.set([68, 100, 130, 255], i * 4);
  const asset = blobs.putPng(Buffer.from(Canvas.encodePNG(64, 64, rgba)));
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 64, height: 64 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'native animatic reload proof' });
  direction.ensureLegacyShot(shotId, { title: 'Wide descent', beat: 'Lena notices the wheel slipping.' });
  const parentId = 'invoke_browser_reload';
  ledger.record({
    id: parentId, requestId: parentId, origin: 'partner_server', turnId: 'turn_browser_reload', shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing', stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'], expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'], sideEffects: ['creates_animatic_candidate'], status: 'proposed',
  });
  const context = contexts.create({ parentRequestId: parentId, env: { RAINDESK_ANIMATIC_FPS_NUM: '24', RAINDESK_ANIMATIC_FPS_DEN: '1' } }).context;
  return pacing.createFromContext({
    contextDigest: context.contextDigest,
    proposal: { label: 'Restrained', rationale: 'Let the realization land before the cut.', fidelity: 'draft', shots: [{ shotId, durationFrames: 72, note: 'hold on Lena' }] },
  }).proposal;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.unref(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close((e) => e ? reject(e) : resolve(port)); });
  });
}

async function waitDevtools(port, child, ms = 25_000) {
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
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)); const pending = this.pending.get(msg.id);
      if (!pending) return; this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message)); else pending.resolve(msg.result || {});
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

async function openPage(browserWsUrl, url) {
  const browser = new URL(browserWsUrl);
  const created = await fetch(`http://${browser.host}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!created.ok) throw new Error(`could not create Chromium page: ${created.status}`);
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  return new CDP(ws);
}

async function value(cdp, expression) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise: false, returnByValue: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(`browser expression failed: ${JSON.stringify(out.exceptionDetails)}`);
  return out.result && out.result.value;
}

async function waitFor(cdp, expression, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await value(cdp, expression)) return; }
    catch (error) { if (!/CDP timeout: Runtime\.evaluate/.test(String(error && error.message))) throw error; }
    await delay(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function nativeClick(cdp, selector) {
  const raw = await value(cdp, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();for(const [fx,fy] of [[.5,.5],[.3,.5],[.7,.5],[.5,.3],[.5,.7]]){const x=r.left+r.width*fx,y=r.top+r.height*fy,h=document.elementFromPoint(x,y);if(h&&(h===e||e.contains(h)))return JSON.stringify({x,y});}return null})()`);
  if (!raw) throw new Error(`native click target not exposed: ${selector}`);
  const p = JSON.parse(raw);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(250);
}

async function captureDiagnostics(page, error) {
  if (!DIAGNOSTICS) return;
  const diag = {
    ok: !error,
    phase,
    gitSha: (() => { try { return require('node:child_process').execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_e) { return null; } })(),
    error: error ? String(error && error.stack || error) : null,
  };
  if (page) {
    try {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      if (SCREENSHOT) fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
      diag.screenshot = true;
    } catch (_e) { diag.screenshot = `failed: ${_e.message}`; }
    const probe = (expression, awaitPromise = false) => page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
      .then((out) => (out.exceptionDetails ? `exception: ${String(out.exceptionDetails.exception && out.exceptionDetails.exception.description || out.exceptionDetails.text).slice(0, 300)}` : out.result && out.result.value))
      .catch((e) => `probe failed: ${e.message}`);
    diag.dom = await probe(`(()=>{const g=document.querySelector('.gens-list');return JSON.stringify({hasGensList:!!g,animaticSection:!!document.querySelector('.animatic-takes-section'),takeCards:document.querySelectorAll('.animatic-take-card').length,takeStatus:(document.querySelector('.animatic-take-status')||{}).textContent||null,video:!!document.querySelector('.animatic-take-card video'),pacingCard:!!document.querySelector('.animatic-pacing-card'),activeTab:(()=>{const t=document.querySelector('.dtab.active');return t?(t.dataset.tab||null):null})(),gensChildren:g?Array.from(g.children).map((c)=>c.className).slice(0,8):null})})()`);
    diag.gensHtmlHead = await probe(`String(document.querySelector('.gens-list')?.innerHTML||'').replace(/\\s+/g,' ').slice(0,1500)`);
    diag.animaticRequests = await probe(`performance.getEntriesByType('resource').filter((e)=>e.name.includes('/api/animatic/')).map((e)=>e.name.replace(location.origin,'')).join('\\n').slice(0,1500)`);
    diag.apiCandidates = await probe(`fetch('/api/animatic/candidates?limit=50').then(async (r)=>r.status+' '+(await r.text()).slice(0,1000))`, true);
    diag.apiReview = await probe(`fetch('/api/animatic/review?candidateId=cand-browser-reload').then(async (r)=>r.status+' '+(await r.text()).slice(0,600))`, true);
  }
  // Diagnostics must never mask the journey error: a write failure here is
  // reported to stderr but the original error keeps propagating.
  try {
    fs.mkdirSync(path.dirname(DIAGNOSTICS), { recursive: true });
    fs.writeFileSync(DIAGNOSTICS, JSON.stringify(diag, null, 2) + '\n');
    console.error(`[animatic-reload] diagnostics written: ${DIAGNOSTICS} phase=${phase}`);
  } catch (writeError) {
    console.error(`[animatic-reload] diagnostics write failed: ${writeError && writeError.message}`);
  }
}

async function main() {
  const watchdog = setTimeout(() => { console.error('[animatic-reload] watchdog expired'); process.exit(124); }, 100_000);
  const proposal = seedProposal();
  const server = createServer({
    partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) },
    sourceRights: 'browser-test-rights',
    animaticEnv: {
      RAINDESK_ANIMATIC_EXECUTOR: fakeExecutor,
      RAINDESK_ANIMATIC_PROJECT_ROOT: PROJECT_ROOT,
      RAINDESK_SOURCE_RIGHTS: 'browser-test-rights',
      RAINDESK_ANIMATIC_TIMEOUT_MS: '10000',
      FAKE_COUNTER_FILE: spawnCounter,
    },
  });
  const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-chromium-reload-'));
  let debugPort = await freePort();
  const chromeArgs = () => ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, '--window-size=1440,900', `--user-data-dir=${profile}`, 'about:blank'];
  let chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
  // Cold CI runners occasionally fail to bring the DevTools listener up
  // (dbus noise, slow first launch). One bounded respawn on a fresh port and
  // profile; a second failure surfaces unchanged. No product assertion is
  // relaxed by this — the journey itself is untouched.
  async function startDevtools() {
    try {
      return await waitDevtools(debugPort, chrome);
    } catch (_firstError) {
      if (chrome.exitCode == null) chrome.kill('SIGKILL');
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-chromium-reload-'));
      debugPort = await freePort();
      chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
      return await waitDevtools(debugPort, chrome);
    }
  }
  let page = null;
  try {
    try {
    const browserWsUrl = await startDevtools();
    page = await openPage(browserWsUrl, base);
    phase = 'first-boot';
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'Raindesk boot');
    await waitFor(page, `!!document.querySelector('.animatic-pacing-card')`, 'restored pacing card');
    if (!(await value(page, `document.querySelector('.animatic-pacing-card')?.textContent?.includes('Restrained')`))) throw new Error('Restrained pacing card missing');

    phase = 'first-preview';
    await nativeClick(page, '.animatic-preview-btn');
    await waitFor(page, `!!document.querySelector('.animatic-take-card video')`, 'playable animatic Take', 25_000);
    await waitFor(page, `document.querySelector('.animatic-take-card video')?.getAttribute('src')?.startsWith('/api/animatic/artifact/')`, 'same-origin MP4');
    phase = 'first-keep';
    await nativeClick(page, '.animatic-take-card .animatic-review-btn.keep');
    await waitFor(page, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'Keep state');

    phase = 'durable-keep-check';
    const decisions = review.list({ candidateId: 'cand-browser-reload' });
    if (decisions.length !== 1 || decisions[0].decision !== 'keep' || decisions[0].actor_role !== 'owner') throw new Error('durable owner Keep missing');
    if (fs.readFileSync(spawnCounter, 'utf8').trim().split('\n').length !== 1) throw new Error('executor spawned more than once');

    // Reconstruct the application from a brand-new document in the same browser
    // process. No page object or DOM state is reused.
    try { page.ws.close(); } catch (_e) {}
    page = null;
    phase = 'fresh-page-open';
    const reloaded = await openPage(browserWsUrl, `${base}?reload-proof=1`);
    page = reloaded;
    phase = 'fresh-boot';
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'fresh-page reload boot');
    phase = 'fresh-pacing';
    await waitFor(page, `!!document.querySelector('.animatic-pacing-card')`, 'pacing after reload');
    await waitFor(page, `!!document.querySelector('[data-tab="gens"]')`, 'Takes tab after reload');
    phase = 'fresh-tab';
    await nativeClick(page, '[data-tab="gens"]');
    phase = 'fresh-keep';
    await waitFor(page, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'Keep after reload');
    phase = 'fresh-take';
    await waitFor(page, `!!document.querySelector('.animatic-take-card video')`, 'Take after reload');

    if (SCREENSHOT) { const image = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); fs.writeFileSync(SCREENSHOT, Buffer.from(image.data, 'base64')); }
    const receipt = {
      ok: true,
      proposalDigest: proposal.proposalDigest,
      candidateId: 'cand-browser-reload',
      reviewDecisionId: decisions[0].decision_id,
      executorSpawns: 1,
      reloadRestored: true,
      reloadMode: 'fresh_page_same_browser',
    };
    if (RECEIPT) fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
    await captureDiagnostics(page, null);
    } catch (journeyError) {
    await captureDiagnostics(page, journeyError);
    throw journeyError;
    }
  } finally {
    if (page && page.ws) try { page.ws.close(); } catch (_e) {}
    if (chrome.exitCode == null) chrome.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    for (const dir of [profile, DATA_DIR, PROJECT_ROOT]) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    clearTimeout(watchdog);
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
