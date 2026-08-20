'use strict';

/**
 * REAL pinned video-skill host proof (Gate 5).
 *
 * One full owner-host journey against the REAL executor (creative-contracts
 * animatic_compile, slice-C v0.2) — not the fake:
 *   saved shot -> Partner pacing proposal -> Preview click -> server prepares
 *   -> REAL external render -> strict import -> browser playback -> owner Keep
 *   -> fresh page -> restored pacing, candidate and Keep state.
 *
 * The receipt is sanitized: no absolute paths, hostnames, tokens or env dumps.
 * Executor identity is bound by the tool file's sha256, not its path.
 *
 * Configuration (explicit, no guessing):
 *   ANIMATIC_REAL_TOOL        absolute path to animatic_compile.py (required)
 *   ANIMATIC_REAL_RECEIPT     receipt output path (optional)
 *   ANIMATIC_REAL_SCREENSHOT  screenshot output path (optional)
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-real-host-data-'));
const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-real-host-projects-'));
const WRAPPER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-real-host-bin-'));
process.env.RAINDESK_DATA_DIR = DATA_DIR;

const REAL_TOOL = process.env.ANIMATIC_REAL_TOOL || '';
const RECEIPT = process.env.ANIMATIC_REAL_RECEIPT || '';
const SCREENSHOT = process.env.ANIMATIC_REAL_SCREENSHOT || '';
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!REAL_TOOL || !path.isAbsolute(REAL_TOOL)) {
  console.error('ANIMATIC_REAL_TOOL must be an absolute path to animatic_compile.py');
  process.exit(2);
}
const toolSha = crypto.createHash('sha256').update(fs.readFileSync(REAL_TOOL)).digest('hex');
// Executable wrapper: the pinned tool itself stays untouched (mode 644 in its
// own repo); the wrapper only re-execs python3 over it. The tool path is
// embedded shell-safely: single-quoted with '\'' escaping, so metacharacters
// ($, backtick, spaces, glob) can never expand in the /bin/sh context.
const toolSh = REAL_TOOL.replace(/'/g, `'\\''`);
const wrapper = path.join(WRAPPER_DIR, 'animatic-executor');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec python3 '${toolSh}' "$@"\n`, { mode: 0o755 });
fs.chmodSync(wrapper, 0o755);

const Canvas = require('../public/js/canvas');
const blobs = require('../lib/blobs');
const docs = require('../lib/shot-documents');
const direction = require('../lib/direction');
const ledger = require('../lib/partner-invocation-ledger');
const contexts = require('../lib/animatic-pacing-context');
const pacing = require('../lib/animatic-pacing-proposals');
const review = require('../lib/animatic-review-decisions');
const executionStore = require('../lib/animatic-execution-store');
const candidatesStore = require('../lib/animatic-candidates');
const { createServer } = require('../server');

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
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)); const pending = this.pending.get(msg.id);
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
  return new CDP(ws);
}

async function value(cdp, expression, awaitPromise = false, timeoutMs = 12_000) {
  const out = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, timeoutMs);
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

async function playbackProof(cdp, label) {
  const raw = await value(cdp, `(async () => {
    const video = document.querySelector('.animatic-take-card video');
    if (!video) return JSON.stringify({ ok: false, reason: 'no video element' });
    if (!video.error && video.readyState < 1) {
      await new Promise((resolve) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        setTimeout(resolve, 20000);
      });
    }
    return JSON.stringify({
      ok: !video.error && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0,
      error: video.error ? String(video.error.code) : null,
      readyState: video.readyState,
      duration: Number.isFinite(video.duration) ? video.duration : null,
    });
  })()`, true, 40_000);
  const proof = JSON.parse(raw);
  if (!proof.ok) throw new Error(`${label} playback proof failed: ${JSON.stringify(proof)}`);
  return proof;
}

function seedProposal() {
  const shotId = 'S01';
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) rgba.set([96, 118, 148, 255], i * 4);
  const asset = blobs.putPng(Buffer.from(Canvas.encodePNG(64, 64, rgba)));
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 64, height: 64 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'real host proof' });
  direction.ensureLegacyShot(shotId, { title: 'Wide descent', beat: 'Lena notices the wheel slipping.' });
  const parentId = 'invoke_real_host';
  ledger.record({
    id: parentId, requestId: parentId, origin: 'partner_server', turnId: 'turn_real_host', shotId,
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

function headSha() {
  try {
    return require('node:child_process').execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (_e) { return null; }
}

async function main() {
  const watchdog = setTimeout(() => { console.error('[real-host] watchdog expired'); process.exit(124); }, 600_000);
  const proposal = seedProposal();
  const server = createServer({
    partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) },
    sourceRights: 'internal-owner-host-proof',
    animaticEnv: {
      RAINDESK_ANIMATIC_EXECUTOR: wrapper,
      RAINDESK_ANIMATIC_PROJECT_ROOT: PROJECT_ROOT,
      RAINDESK_SOURCE_RIGHTS: 'internal-owner-host-proof',
      RAINDESK_ANIMATIC_TIMEOUT_MS: '540000',
    },
  });
  const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-real-host-chrome-'));
  let debugPort = await freePort();
  const chromeArgs = () => ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, '--window-size=1440,900', `--user-data-dir=${profile}`, 'about:blank'];
  let chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
  async function startDevtools() {
    try { return await waitDevtools(debugPort, chrome); }
    catch (_firstError) {
      if (chrome.exitCode == null) chrome.kill('SIGKILL');
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_e) {}
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-real-host-chrome-'));
      debugPort = await freePort();
      chrome = spawn(CHROME, chromeArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
      return await waitDevtools(debugPort, chrome);
    }
  }
  let page = null;
  try {
    const browserWsUrl = await startDevtools();
    page = await openPage(browserWsUrl, base);
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'Raindesk boot', 60_000);
    await waitFor(page, `!!document.querySelector('.animatic-pacing-card')`, 'restored pacing card');
    if (!(await value(page, `document.querySelector('.animatic-pacing-card')?.textContent?.includes('Restrained')`))) throw new Error('Restrained pacing card missing');

    await nativeClick(page, '.animatic-preview-btn');
    // Async preview + REAL render: the client polls; wait for the playable take.
    await waitFor(page, `!!document.querySelector('.animatic-take-card video')`, 'REAL render to finish and land in Takes', 420_000);
    await waitFor(page, `document.querySelector('.animatic-take-card video')?.getAttribute('src')?.startsWith('/api/animatic/artifact/')`, 'same-origin MP4');
    const firstPlayback = await playbackProof(page, 'first-page REAL Take');

    await nativeClick(page, '.animatic-take-card .animatic-review-btn.keep');
    await waitFor(page, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'Keep state');

    // Durable server-side witnesses.
    const decisions = review.list({ candidateId: null, sequenceId: 'scene-legacy_board' });
    const keep = decisions.find((d) => d.decision === 'keep' && d.actor_role === 'owner');
    if (!keep) throw new Error('durable owner Keep missing');
    const rows = executionStore.read().attempts.filter((row) => row.invocationId && row.invocationId.startsWith('animatic_'));
    if (rows.length !== 1) throw new Error(`expected exactly one execution row, found ${rows.length}`);
    const row = rows[0];
    if (row.status !== 'succeeded' || !row.externalAttemptId || !row.candidateId) throw new Error(`execution row not a clean real success: ${JSON.stringify(row)}`);
    const candidateRecord = candidatesStore.read(row.candidateId);
    const cand = candidateRecord.candidate;
    const art = candidateRecord.artifacts[0];
    const snapshot = require('../lib/animatic-snapshots').read(row.snapshotDigest);
    const frames = snapshot.shots.reduce((sum, shot) => sum + shot.duration_frames, 0);
    if (cand.media.width !== snapshot.width || cand.media.height !== snapshot.height) throw new Error('real media dimensions do not match snapshot');
    if (cand.media.fps_num !== snapshot.fps_num || cand.media.fps_den !== snapshot.fps_den) throw new Error('real media fps does not match snapshot');
    if (cand.media.duration.num !== frames * snapshot.fps_den || cand.media.duration.den !== snapshot.fps_num) throw new Error('real media duration does not equal snapshot frame total');

    // Fresh page: full reconstruction from durable authority.
    try { page.ws.close(); } catch (_e) {}
    page = await openPage(browserWsUrl, `${base}?real-host-proof=1`);
    await waitFor(page, `document.documentElement?.dataset?.raindeskBoot==='ready'`, 'fresh-page boot', 60_000);
    await waitFor(page, `!!document.querySelector('.animatic-pacing-card')`, 'pacing after reload');
    await nativeClick(page, '[data-tab="gens"]');
    await waitFor(page, `document.querySelector('.animatic-take-status')?.textContent?.includes('kept')`, 'Keep after reload');
    await waitFor(page, `!!document.querySelector('.animatic-take-card video')`, 'Take after reload');
    const freshPlayback = await playbackProof(page, 'fresh-page REAL Take');
    await value(page, `(()=>{const v=document.querySelector('.animatic-take-card video'); if(v) v.currentTime=0.1; return true;})()`);
    await waitFor(page, `(()=>{const v=document.querySelector('.animatic-take-card video');return !!(v && v.currentTime>0 && !v.error)})()`, 'seek advances without media error', 10_000);

    if (SCREENSHOT) { const image = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); fs.writeFileSync(SCREENSHOT, Buffer.from(image.data, 'base64')); }

    // Sanitized receipt: identity by hashes and ids only — no paths, hosts, env.
    const receipt = {
      ok: true,
      proof: 'real-video-skill-host-v1',
      raindeskHead: headSha(),
      executor: {
        toolSha256: toolSha,
        // adapter identity comes from the attempt record:
        adapterIdFromAttempt: candidateRecord.attempt.adapter_id,
        adapterVersionFromAttempt: candidateRecord.attempt.adapter_version || null,
      },
      proposalDigest: proposal.proposalDigest,
      snapshotDigest: row.snapshotDigest,
      executionId: row.executionId,
      externalAttemptId: row.externalAttemptId,
      candidateId: row.candidateId,
      artifact: { sha256: art.sha, bytes: art.bytes, mimeType: art.mimeType },
      validatedMedia: { width: cand.media.width, height: cand.media.height, fps: `${cand.media.fps_num}/${cand.media.fps_den}`, durationSeconds: cand.media.duration.num / cand.media.duration.den },
      executorSpawns: rows.length,
      browserPlayback: { first: firstPlayback, fresh: freshPlayback, seekAdvanced: true },
      reviewDecisionId: keep.decision_id,
      reloadRestored: true,
      reloadMode: 'fresh_page_same_browser',
    };
    if (RECEIPT) fs.writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  } finally {
    // Defuse the watchdog on EVERY exit path: a failing step must surface its
    // real error promptly (exit 1) instead of being masked by a 10-minute
    // watchdog kill that also orphans Chrome.
    clearTimeout(watchdog);
    try { if (page && page.ws) page.ws.close(); } catch (_e) {}
    if (chrome.exitCode == null) chrome.kill('SIGKILL');
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    // DATA_DIR and PROJECT_ROOT are deliberately RETAINED on failure (and on
    // success) for post-mortem inspection of the real render outputs; only the
    // scratch wrapper directory and browser profile are transient.
    for (const dir of [profile, WRAPPER_DIR]) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
