'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-prep-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const direction = require('../direction');
const ledger = require('../partner-invocation-ledger');
const prep = require('../animatic-preparation');

function solidPng(rgba) {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set(rgba, i * 4);
  return Buffer.from(Canvas.encodePNG(8, 8, data));
}

function saveShot(shotId, rgba) {
  const asset = blobs.putPng(solidPng(rgba));
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'animatic prep fixture' });
  direction.ensureLegacyShot(shotId, { title: shotId, beat: `beat ${shotId}` });
  return revision;
}

function parent(id, shotId, revisionId) {
  return ledger.record({
    id, requestId: id, origin: 'partner_server', turnId: `turn_${id}`, shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal',
    reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'],
    requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'], sideEffects: ['creates_animatic_candidate'],
    status: 'proposed',
  }).entry;
}

function snapshotInput(shots, patch = {}) {
  return {
    projectId: 'after-last-rain', sequenceId: 'seq-prep', fpsNum: 24, fpsDen: 1,
    fidelity: 'draft', shots, ...patch,
  };
}

test('preparation creates a new deterministic server-prepared child bound to exact snapshot digest and still proposed', () => {
  const a = saveShot('PREP_A', [10, 20, 30, 255]);
  const b = saveShot('PREP_B', [40, 50, 60, 255]);
  const coarse = parent('invoke_animatic_parent', 'PREP_A', a.revisionId);
  const input = snapshotInput([
    { shotId: 'PREP_A', revisionId: a.revisionId, durationFrames: 18 },
    { shotId: 'PREP_B', revisionId: b.revisionId, durationFrames: 30 },
  ]);

  const first = prep.prepare({ parentRequestId: coarse.id, snapshotInput: input, sourceRights: 'owner-controlled project artwork' });
  const second = prep.prepare({ parentRequestId: coarse.id, snapshotInput: input, sourceRights: 'owner-controlled project artwork' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.invocation.id, second.invocation.id);
  assert.notEqual(first.invocation.id, coarse.id, 'prepared approval has separate identity');
  assert.equal(first.invocation.origin, 'server_prepared');
  assert.equal(first.invocation.parentRequestId, coarse.id);
  assert.equal(first.invocation.sourceSnapshotDigest, first.snapshot.snapshot_digest);
  assert.equal(first.invocation.status, 'proposed', 'preparation itself cannot approve execution');
  assert.deepEqual(first.snapshot.shots.map((shot) => shot.shot_id), ['PREP_A', 'PREP_B']);
  assert.equal(JSON.stringify(first.snapshot).includes(scratch), false, 'public prepared summary hides local panel paths');
});

test('different timing creates a different digest-bound child proposal', () => {
  const a = saveShot('PACE_A', [70, 80, 90, 255]);
  const coarse = parent('invoke_pace_parent', 'PACE_A', a.revisionId);
  const one = prep.prepare({
    parentRequestId: coarse.id,
    snapshotInput: snapshotInput([{ shotId: 'PACE_A', revisionId: a.revisionId, durationFrames: 12 }], { sequenceId: 'pace-seq' }),
    sourceRights: 'owner-controlled project artwork',
  });
  const two = prep.prepare({
    parentRequestId: coarse.id,
    snapshotInput: snapshotInput([{ shotId: 'PACE_A', revisionId: a.revisionId, durationFrames: 20 }], { sequenceId: 'pace-seq' }),
    sourceRights: 'owner-controlled project artwork',
  });
  assert.notEqual(one.snapshot.snapshot_digest, two.snapshot.snapshot_digest);
  assert.notEqual(one.invocation.id, two.invocation.id);
});

test('preparation refuses missing or non-server parents, missing rights and artwork drift from parent authority', () => {
  const a = saveShot('GUARD_A', [100, 110, 120, 255]);
  const coarse = parent('invoke_guard_parent', 'GUARD_A', a.revisionId);
  const exact = snapshotInput([{ shotId: 'GUARD_A', revisionId: a.revisionId, durationFrames: 10 }], { sequenceId: 'guard-seq' });

  assert.throws(
    () => prep.prepare({ parentRequestId: 'browser_minted_missing', snapshotInput: exact, sourceRights: 'owner' }),
    (error) => error.status === 404,
  );
  const forged = ledger.record({ ...coarse, id: 'http_forged_parent', requestId: 'http_forged_parent', origin: 'http_legacy' }).entry;
  assert.throws(
    () => prep.prepare({ parentRequestId: forged.id, snapshotInput: exact, sourceRights: 'owner' }),
    (error) => error.status === 409 && /server-side Partner/.test(error.message),
  );
  assert.throws(
    () => prep.prepare({ parentRequestId: coarse.id, snapshotInput: exact, sourceRights: '' }),
    (error) => error.status === 503,
  );
  assert.throws(
    () => prep.prepare({
      parentRequestId: coarse.id,
      snapshotInput: snapshotInput([{ shotId: 'GUARD_A', revisionId: 'rev_different', durationFrames: 10 }], { sequenceId: 'guard-seq' }),
      sourceRights: 'owner',
    }),
    (error) => error.status === 409,
  );
  assert.throws(
    () => prep.prepare({
      parentRequestId: coarse.id,
      snapshotInput: snapshotInput([{ shotId: 'OTHER_SHOT', revisionId: a.revisionId, durationFrames: 10 }], { sequenceId: 'guard-seq' }),
      sourceRights: 'owner',
    }),
    (error) => error.status === 409,
  );
});

test('prepared snapshot must be separately approved, cannot be resurrected, and its digest cannot be rebound', () => {
  const a = saveShot('APPROVE_A', [130, 140, 150, 255]);
  const coarse = parent('invoke_approval_parent', 'APPROVE_A', a.revisionId);
  const prepared = prep.prepare({
    parentRequestId: coarse.id,
    snapshotInput: snapshotInput([{ shotId: 'APPROVE_A', revisionId: a.revisionId, durationFrames: 15 }], { sequenceId: 'approval-seq' }),
    sourceRights: 'owner',
  });
  assert.equal(prepared.invocation.status, 'proposed');
  assert.throws(
    () => ledger.record({ id: prepared.invocation.id, sourceSnapshotDigest: 'b'.repeat(64) }),
    (error) => error.status === 409,
  );
  const approved = ledger.setStatus(prepared.invocation.id, 'approved');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.sourceSnapshotDigest, prepared.snapshot.snapshot_digest);
  ledger.setStatus(prepared.invocation.id, 'stale');
  assert.throws(
    () => ledger.setStatus(prepared.invocation.id, 'approved'),
    (error) => error.status === 409 && /stale to approved/.test(error.message),
    'stale execution authority is terminal and cannot be resurrected',
  );
});
