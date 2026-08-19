'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-preview-route-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const direction = require('../direction');
const ledger = require('../partner-invocation-ledger');
const pacingContexts = require('../animatic-pacing-context');
const pacing = require('../animatic-pacing-proposals');
const review = require('../animatic-review-decisions');
const { createServer } = require('../../server');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-preview-projects-'));
const counter = path.join(scratch, 'preview-spawns.txt');
const fake = path.join(scratch, 'fake-preview-executor');

fs.writeFileSync(fake, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const snapshotFile = arg('--snapshot');
const outDir = arg('--out-dir');
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
if (process.env.FAKE_COUNTER_FILE) fs.appendFileSync(process.env.FAKE_COUNTER_FILE, 'spawn\\n');
const attemptId = 'att-preview';
const candidateId = 'cand-preview';
const runDir = path.join(outDir, attemptId);
fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(runDir, 'source-snapshot.json'), JSON.stringify(snapshot, null, 2));
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(32, 7)]);
fs.writeFileSync(path.join(runDir, 'artifacts', 'animatic.mp4'), mp4);
const sha = crypto.createHash('sha256').update(mp4).digest('hex');
const attempt = {
  schema_version:'0.2.0', attempt_id:attemptId, source_snapshot_digest:snapshot.snapshot_digest,
  adapter_id:'animatic_timing_v1', adapter_version:'0.2.0', engine:{engine_id:'fake-preview'},
  lifecycle:'succeeded', terminal_status:'succeeded', started_at:new Date().toISOString(), ended_at:new Date().toISOString(),
  error:null, candidate_refs:[candidateId], extensions:{}
};
const frames = snapshot.shots.reduce((sum, shot) => sum + shot.duration_frames, 0);
const candidate = {
  schema_version:'0.2.0', candidate_id:candidateId, sequence_id:snapshot.sequence_id, project_id:snapshot.project_id,
  attempt_id:attemptId, source_snapshot_digest:snapshot.snapshot_digest,
  fidelity:{level:snapshot.fidelity,note:'fake preview'},
  files:[{path:'artifacts/animatic.mp4',sha256:sha,bytes:mp4.length,mime_type:'video/mp4'}],
  media:{width:snapshot.width,height:snapshot.height,fps_num:snapshot.fps_num,fps_den:snapshot.fps_den,
    duration:{num:frames * snapshot.fps_den,den:snapshot.fps_num},alpha:false},
  provenance:{created_at:new Date().toISOString(),tool:'fake-preview'},
  rights:{license:'internal',owner:'test',source_rights:'test-rights'},extensions:{}
};
fs.writeFileSync(path.join(runDir, 'execution-attempt.json'), JSON.stringify(attempt, null, 2));
fs.writeFileSync(path.join(runDir, 'sequence-candidate.json'), JSON.stringify(candidate, null, 2));
console.log(JSON.stringify({ok:true,attempt_id:attemptId,candidate_id:candidateId,run_dir:runDir}));
`, { mode: 0o755 });
fs.chmodSync(fake, 0o755);

function solidPng(value = 30) {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([value, value + 20, value + 40, 255], i * 4);
  return Buffer.from(Canvas.encodePNG(8, 8, data));
}

function seedProposal() {
  const suffix = crypto.randomBytes(4).toString('hex');
  const shotId = `PREVIEW_${suffix}`;
  const parentId = `invoke_preview_${suffix}`;
  const asset = blobs.putPng(solidPng());
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'preview route fixture' });
  direction.ensureLegacyShot(shotId, { title: `Preview ${suffix}`, beat: 'hold, then cut' });
  ledger.record({
    id: parentId, requestId: parentId, origin: 'partner_server', turnId: `turn_${suffix}`, shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing', stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'], expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'], sideEffects: ['creates_animatic_candidate'], status: 'proposed',
  });
  const context = pacingContexts.create({ parentRequestId: parentId, env: { RAINDESK_ANIMATIC_FPS_NUM: '24', RAINDESK_ANIMATIC_FPS_DEN: '1' } }).context;
  const proposal = pacing.createFromContext({
    contextDigest: context.contextDigest,
    proposal: { label: 'Restrained', rationale: 'Let it land.', fidelity: 'draft', shots: [{ shotId, durationFrames: 36, note: 'hold then cut' }] },
  }).proposal;
  return { proposal, revision, shotId };
}

async function withServer(t, fn) {
  const animaticEnv = {
    RAINDESK_ANIMATIC_EXECUTOR: fake,
    RAINDESK_ANIMATIC_PROJECT_ROOT: projectRoot,
    RAINDESK_SOURCE_RIGHTS: 'test-rights',
    RAINDESK_ANIMATIC_TIMEOUT_MS: '10000',
    FAKE_COUNTER_FILE: counter,
  };
  const server = createServer({
    partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) },
    sourceRights: 'test-rights', animaticEnv,
  });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(() => new Promise((resolve) => { server.close(() => resolve()); for (const socket of sockets) socket.destroy(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fn(`http://127.0.0.1:${server.address().port}`);
}

test('Preview this approves exact proposal, renders one immutable candidate, and repeat is idempotent', async (t) => {
  const { proposal, shotId } = seedProposal();
  await withServer(t, async (base) => {
    let res = await fetch(`${base}/api/animatic/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalDigest: proposal.proposalDigest }),
    });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.proposal.proposalDigest, proposal.proposalDigest);
    assert.equal(body.execution.status, 'succeeded');
    assert.equal(body.candidate.candidate.candidate_id, 'cand-preview');
    assert.match(body.candidate.artifacts[0].url, /^\/api\/animatic\/artifact\/[a-f0-9]{64}$/);
    assert.equal(body.candidate.candidate.review_state, undefined);
    assert.equal(review.list({ candidateId: 'cand-preview' }).length, 0, 'preview never auto-keeps a candidate');

    const preparedRows = ledger.list({ shotId, limit: 100 }).filter((row) => row.origin === 'server_prepared');
    assert.equal(preparedRows.length, 1);
    assert.equal(preparedRows[0].status, 'handed_off');

    res = await fetch(`${base}/api/animatic/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalDigest: proposal.proposalDigest }),
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.candidate.candidate.candidate_id, 'cand-preview');
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'same successful preview does not spawn twice');

    res = await fetch(`${base}/api/animatic/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalDigest: proposal.proposalDigest, invocationId: 'browser-forged' }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /only one stored proposalDigest/);
  });
});

test('stale stored proposal cannot be previewed after artwork changes', async (t) => {
  const { proposal, revision, shotId } = seedProposal();
  const asset = blobs.putPng(solidPng(100));
  docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { baseRevisionId: revision.revisionId, reason: 'make old pacing stale' });
  await withServer(t, async (base) => {
    const res = await fetch(`${base}/api/animatic/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalDigest: proposal.proposalDigest }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /stale/);
  });
});
