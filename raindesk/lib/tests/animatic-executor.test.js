'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-executor-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const direction = require('../direction');
const snapshots = require('../animatic-snapshots');
const ledger = require('../partner-invocation-ledger');
const executionStore = require('../animatic-execution-store');
const videoArtifacts = require('../video-artifacts');
const executor = require('../animatic-executor');

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-video-projects-'));
const fakeExecutor = path.join(scratch, 'fake-animatic-executor');

fs.writeFileSync(fakeExecutor, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const snapshotPath = arg('--snapshot');
const outDir = arg('--out-dir');
const mode = process.env.FAKE_MODE || 'success';
if (process.env.FAKE_COUNTER_FILE) fs.appendFileSync(process.env.FAKE_COUNTER_FILE, 'spawn\\n');
const sleep = Number(process.env.FAKE_SLEEP_MS || 0);
const run = () => {
  if (mode === 'exit') { console.error('fake failure'); process.exit(7); }
  if (mode === 'malformed') { console.log('not terminal json'); return; }
  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const attemptId = 'att-fake-' + crypto.randomBytes(4).toString('hex');
  const candidateId = 'cand-' + attemptId.slice(4);
  let runDir = path.join(outDir, attemptId);
  if (mode === 'escape') runDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'escaped-attempt-'));
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  const copied = JSON.parse(JSON.stringify(snap));
  if (mode === 'copy-drift') copied.fidelity = copied.fidelity === 'draft' ? 'preview' : 'draft';
  fs.writeFileSync(path.join(runDir, 'source-snapshot.json'), JSON.stringify(copied, null, 2));
  const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(32, 1)]);
  const mp4Path = path.join(runDir, 'artifacts', 'animatic.mp4');
  fs.writeFileSync(mp4Path, mp4);
  const sha = crypto.createHash('sha256').update(mp4).digest('hex');
  const attempt = {
    schema_version: '0.2.0', attempt_id: attemptId, source_snapshot_digest: snap.snapshot_digest,
    adapter_id: 'animatic_timing_v1', adapter_version: '0.2.0', engine: { engine_id: 'fake-video' },
    lifecycle: 'succeeded', terminal_status: 'succeeded', started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(), error: null, candidate_refs: [candidateId], extensions: {}
  };
  const candidate = {
    schema_version: '0.2.0', candidate_id: candidateId, sequence_id: snap.sequence_id, project_id: snap.project_id,
    attempt_id: attemptId, source_snapshot_digest: snap.snapshot_digest,
    fidelity: { level: snap.fidelity, note: 'fake CI animatic' },
    files: [{ path: 'artifacts/animatic.mp4', sha256: mode === 'bad-hash' ? '0'.repeat(64) : sha, bytes: mp4.length, mime_type: 'video/mp4' }],
    media: { width: snap.width, height: snap.height, fps_num: snap.fps_num, fps_den: snap.fps_den,
      duration: { num: snap.shots.reduce((n, s) => n + s.duration_frames, 0), den: snap.fps_num,
        timebase: { num: snap.fps_num, den: 1 }, conversion_policy: 'exact' }, alpha: false },
    provenance: { created_at: new Date().toISOString(), tool: 'fake-animatic' },
    rights: { license: 'internal', owner: 'test', source_rights: 'test-rights' }, extensions: {}
  };
  if (mode === 'review-state') candidate.review_state = 'keep';
  fs.writeFileSync(path.join(runDir, 'execution-attempt.json'), JSON.stringify(attempt, null, 2));
  fs.writeFileSync(path.join(runDir, 'sequence-candidate.json'), JSON.stringify(candidate, null, 2));
  console.log(JSON.stringify({ ok: true, attempt_id: attemptId, candidate_id: candidateId, run_dir: runDir, mp4: mp4Path }));
};
if (sleep > 0) setTimeout(run, sleep); else run();
`, { mode: 0o755 });
fs.chmodSync(fakeExecutor, 0o755);

function solidPng(rgba) {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set(rgba, i * 4);
  return Buffer.from(Canvas.encodePNG(8, 8, data));
}

let serial = 0;
function approvedInvocation(label = 'exec') {
  serial += 1;
  const shotId = `EXEC_${label}_${serial}`;
  const asset = blobs.putPng(solidPng([20 + serial, 40, 60, 255]));
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'executor fixture' });
  direction.ensureLegacyShot(shotId, { title: shotId, beat: 'hold for the animatic' });
  const snapshot = snapshots.compile({
    projectId: 'after-last-rain', sequenceId: `seq-${label}-${serial}`, fpsNum: 24, fpsDen: 1,
    fidelity: 'draft', sourceRights: 'test-rights',
    shots: [{ shotId, revisionId: revision.revisionId, durationFrames: 12 + serial }],
  });
  const id = `animatic_exec_${label}_${serial}`;
  ledger.record({
    id, requestId: id, origin: 'server_prepared', parentRequestId: `parent_${id}`,
    sourceSnapshotDigest: snapshot.snapshot_digest, turnId: `turn_${id}`, shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass', invocationBoundary: 'external',
    disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['ExecutionAttempt@0.2.0', 'SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'], sideEffects: ['creates_animatic_candidate'], status: 'proposed',
  });
  ledger.setStatus(id, 'approved');
  return { id, snapshot };
}

function env(patch = {}) {
  return {
    RAINDESK_ANIMATIC_EXECUTOR: fakeExecutor,
    RAINDESK_ANIMATIC_PROJECT_ROOT: projectRoot,
    RAINDESK_SOURCE_RIGHTS: 'test-rights',
    RAINDESK_ANIMATIC_TIMEOUT_MS: '10000',
    ...patch,
  };
}

test('approved prepared invocation executes without shell, imports immutable MP4, and repeats idempotently', async () => {
  const prepared = approvedInvocation('success');
  const counter = path.join(scratch, 'success-counter.txt');
  const first = await executor.execute(prepared.id, { env: env({ FAKE_COUNTER_FILE: counter }) });
  assert.equal(first.execution.status, 'succeeded');
  assert.ok(first.candidate);
  assert.equal(first.candidate.snapshotDigest, prepared.snapshot.snapshot_digest);
  assert.equal(first.candidate.candidate.review_state, undefined, 'candidate carries no acceptance state');
  assert.equal(first.candidate.artifacts.length, 1);
  assert.match(first.candidate.artifacts[0].url, /^\/api\/animatic\/artifact\/[a-f0-9]{64}$/);
  assert.equal(videoArtifacts.stat(first.candidate.artifacts[0].sha).bytes, first.candidate.artifacts[0].bytes);
  assert.equal(JSON.stringify(first).includes(scratch), false, 'public execution result does not leak run/executable paths');
  assert.equal(ledger.find(ledger.read(), prepared.id).status, 'handed_off');

  const again = await executor.execute(prepared.id, { env: env({ FAKE_COUNTER_FILE: counter }) });
  assert.equal(again.execution.executionId, first.execution.executionId);
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'successful request is not launched twice');
});

test('concurrent duplicate execute calls share one in-flight process', async () => {
  const prepared = approvedInvocation('concurrent');
  const counter = path.join(scratch, 'concurrent-counter.txt');
  const options = { env: env({ FAKE_COUNTER_FILE: counter, FAKE_SLEEP_MS: '150' }) };
  const [a, b] = await Promise.all([executor.execute(prepared.id, options), executor.execute(prepared.id, options)]);
  assert.equal(a.execution.executionId, b.execution.executionId);
  assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
});

test('non-zero worker failure is durable and retry requires explicit opt-in', async () => {
  const prepared = approvedInvocation('retry');
  await assert.rejects(
    executor.execute(prepared.id, { env: env({ FAKE_MODE: 'exit' }) }),
    (error) => error.status === 502,
  );
  const failed = executionStore.latestForInvocation(prepared.id);
  assert.equal(failed.status, 'failed');
  assert.equal(ledger.find(ledger.read(), prepared.id).status, 'handed_off');
  await assert.rejects(
    executor.execute(prepared.id, { env: env() }),
    (error) => error.status === 409 && /retry=true/.test(error.message),
  );
  const retried = await executor.execute(prepared.id, { retry: true, env: env() });
  assert.equal(retried.execution.status, 'succeeded');
  assert.notEqual(retried.execution.executionId, failed.executionId);
});

test('malformed, escaping, hash-mismatched and review-state outputs fail closed', async () => {
  for (const mode of ['malformed', 'escape', 'bad-hash', 'review-state', 'copy-drift']) {
    const prepared = approvedInvocation(mode.replace('-', '_'));
    await assert.rejects(
      executor.execute(prepared.id, { env: env({ FAKE_MODE: mode }) }),
      (error) => error.status === 502,
      `mode ${mode} must not import a candidate`,
    );
    assert.equal(executionStore.latestForInvocation(prepared.id).status, 'failed');
  }
});

test('restart recovery converts orphaned running attempts to interrupted', () => {
  const prepared = approvedInvocation('recovery');
  const row = executionStore.begin({ invocationId: prepared.id, snapshotDigest: prepared.snapshot.snapshot_digest });
  assert.equal(row.status, 'running');
  assert.ok(executionStore.recoverInterrupted() >= 1);
  assert.equal(executionStore.get(row.executionId).status, 'interrupted');
});

test('video artifact range parser supports browser byte ranges and rejects invalid ranges', () => {
  assert.deepEqual(videoArtifacts.parseRange('bytes=2-5', 20), { start: 2, end: 5, length: 4 });
  assert.deepEqual(videoArtifacts.parseRange('bytes=10-', 20), { start: 10, end: 19, length: 10 });
  assert.deepEqual(videoArtifacts.parseRange('bytes=-5', 20), { start: 15, end: 19, length: 5 });
  assert.throws(() => videoArtifacts.parseRange('bytes=50-60', 20), (error) => error.status === 416);
});
