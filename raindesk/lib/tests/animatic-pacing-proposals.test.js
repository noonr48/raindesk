'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-pacing-proposal-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const ledger = require('../partner-invocation-ledger');
const pacing = require('../animatic-pacing-proposals');

function solidPng(value) {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([value, value + 1, value + 2, 255], i * 4);
  return Buffer.from(Canvas.encodePNG(8, 8, data));
}

function saveShot(shotId, value) {
  const asset = blobs.putPng(solidPng(value));
  let current = null;
  try { current = docs.readCurrent(shotId); } catch (_error) { current = null; }
  return docs.save(shotId, {
    schemaVersion: 1,
    shotId,
    canvas: { width: 8, height: 8 },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { baseRevisionId: current && current.revisionId || null, reason: 'pacing proposal fixture' });
}

function parent(id, shotId, revisionId, origin = 'partner_server') {
  return ledger.record({
    id,
    requestId: id,
    origin,
    turnId: `turn_${id}`,
    shotId,
    adapterId: 'animatic_timing_v1',
    capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing',
    recipeId: 'animatic_pass',
    invocationBoundary: 'external',
    disposition: 'proposal',
    reviewRequired: true,
    creativeMutation: true,
    scope: { shotId, artRevisionId: revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'],
    requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'],
    sideEffects: ['creates_animatic_candidate'],
    status: 'proposed',
  }).entry;
}

function creative(shots, patch = {}) {
  return {
    projectId: 'after-last-rain',
    sequenceId: 'seq-slope-chase',
    fpsNum: 24,
    fpsDen: 1,
    fidelity: 'draft',
    label: 'Restrained tension',
    rationale: 'Let the reaction breathe before the loss of grip.',
    shots,
    ...patch,
  };
}

test('Partner timing is bound to server-owned revisions and persisted deterministically', () => {
  const a = saveShot('PACE_A', 20);
  const b = saveShot('PACE_B', 40);
  const p = parent('invoke_pacing_parent', 'PACE_A', a.revisionId);
  const input = creative([
    { shotId: 'PACE_A', durationFrames: 78, note: 'wide descent' },
    { shotId: 'PACE_B', durationFrames: 34, note: 'hold on Lena' },
  ]);

  const first = pacing.create({ parentRequestId: p.id, proposal: input });
  const second = pacing.create({ parentRequestId: p.id, proposal: input });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.proposal.proposalId, second.proposal.proposalId);
  assert.equal(first.proposal.proposalDigest, second.proposal.proposalDigest);
  assert.deepEqual(first.proposal.shots.map((item) => item.revisionId), [a.revisionId, b.revisionId]);
  assert.equal(first.proposal.shots[0].revisionId, a.revisionId, 'model never supplies the active revision');

  const publicView = pacing.publicProposal(first.proposal);
  assert.equal(publicView.stale, false);
  assert.equal(publicView.totalFrames, 112);
  assert.deepEqual(publicView.totalTime, { num: 14, den: 3 });
  assert.equal(publicView.totalSeconds, 4.667, 'rounded seconds are presentation only');
  assert.deepEqual(publicView.shots[0].durationTime, { num: 13, den: 4 });
  assert.equal(publicView.shots[0].durationSeconds, 3.25);
  assert.equal(JSON.stringify(publicView).includes(scratch), false, 'public proposal has no local path');
  assert.deepEqual(pacing.snapshotInput(first.proposal).shots, [
    { shotId: 'PACE_A', revisionId: a.revisionId, durationFrames: 78 },
    { shotId: 'PACE_B', revisionId: b.revisionId, durationFrames: 34 },
  ]);
});

test('order, duration, note and source revision changes produce different proposal identity', () => {
  const a = saveShot('PACE_ID_A', 60);
  const b = saveShot('PACE_ID_B', 80);
  const p = parent('invoke_pacing_identity', 'PACE_ID_A', a.revisionId);
  const base = creative([
    { shotId: 'PACE_ID_A', durationFrames: 48, note: 'establish' },
    { shotId: 'PACE_ID_B', durationFrames: 24, note: 'reaction' },
  ], { sequenceId: 'seq-identity' });
  const one = pacing.create({ parentRequestId: p.id, proposal: base }).proposal;
  const changedDuration = pacing.create({ parentRequestId: p.id, proposal: {
    ...base,
    shots: [base.shots[0], { ...base.shots[1], durationFrames: 25 }],
  } }).proposal;
  const changedNote = pacing.create({ parentRequestId: p.id, proposal: {
    ...base,
    shots: [base.shots[0], { ...base.shots[1], note: 'hard reaction' }],
  } }).proposal;
  const changedOrder = pacing.create({ parentRequestId: p.id, proposal: {
    ...base,
    shots: [base.shots[1], base.shots[0]],
  } }).proposal;
  assert.notEqual(one.proposalDigest, changedDuration.proposalDigest);
  assert.notEqual(one.proposalDigest, changedNote.proposalDigest);
  assert.notEqual(one.proposalDigest, changedOrder.proposalDigest);

  saveShot('PACE_ID_B', 100);
  const changedSource = pacing.create({ parentRequestId: p.id, proposal: base }).proposal;
  assert.notEqual(one.proposalDigest, changedSource.proposalDigest);
  const fresh = pacing.freshness(one);
  assert.equal(fresh.stale, true);
  assert.deepEqual(fresh.changedShots.map((item) => item.shotId), ['PACE_ID_B']);
});

test('closed-world validation rejects malformed, duplicate, missing and oversized creative timing', () => {
  const a = saveShot('PACE_GUARD_A', 120);
  const p = parent('invoke_pacing_guard', 'PACE_GUARD_A', a.revisionId);
  assert.throws(
    () => pacing.create({ parentRequestId: p.id, proposal: creative([{ shotId: 'PACE_GUARD_A', durationFrames: 12 }], { executorPath: '/tmp/forged' }) }),
    (error) => error.status === 400 && /unsupported field executorPath/.test(error.message),
  );
  assert.throws(
    () => pacing.create({ parentRequestId: p.id, proposal: creative([
      { shotId: 'PACE_GUARD_A', durationFrames: 12 },
      { shotId: 'PACE_GUARD_A', durationFrames: 8 },
    ]) }),
    (error) => error.status === 400 && /duplicate shot/.test(error.message),
  );
  assert.throws(
    () => pacing.create({ parentRequestId: p.id, proposal: creative([{ shotId: 'PACE_GUARD_A', durationFrames: 0 }]) }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => pacing.create({ parentRequestId: p.id, proposal: creative([{ shotId: 'MISSING_ART', durationFrames: 12 }]) }),
    (error) => error.status === 409 && /must include the parent invocation shot/.test(error.message),
  );
  assert.throws(
    () => pacing.create({ parentRequestId: p.id, proposal: creative([
      { shotId: 'PACE_GUARD_A', durationFrames: 12 },
      { shotId: 'MISSING_ART', durationFrames: 12 },
    ]) }),
    (error) => error.status === 409 && /no readable persisted artwork revision/.test(error.message),
  );
});

test('parent authority is server-minted and the exact frozen active revision cannot drift', () => {
  const a = saveShot('PACE_PARENT_A', 140);
  const legacy = parent('invoke_http_pacing', 'PACE_PARENT_A', a.revisionId, 'http_legacy');
  assert.throws(
    () => pacing.create({ parentRequestId: legacy.id, proposal: creative([{ shotId: 'PACE_PARENT_A', durationFrames: 24 }]) }),
    (error) => error.status === 409,
  );

  const trusted = parent('invoke_trusted_pacing', 'PACE_PARENT_A', a.revisionId);
  saveShot('PACE_PARENT_A', 160);
  assert.throws(
    () => pacing.create({ parentRequestId: trusted.id, proposal: creative([{ shotId: 'PACE_PARENT_A', durationFrames: 24 }]) }),
    (error) => error.status === 409 && /artwork changed/.test(error.message),
  );
});

test('proposal ids cannot smuggle model-authored revision or path authority', () => {
  const a = saveShot('PACE_FORGE_A', 180);
  const p = parent('invoke_pacing_forge', 'PACE_FORGE_A', a.revisionId);
  assert.throws(
    () => pacing.create({ parentRequestId: p.id, proposal: creative([{
      shotId: 'PACE_FORGE_A', durationFrames: 24, revisionId: 'model_forged_revision',
    }]) }),
    (error) => error.status === 400 && /unsupported field revisionId/.test(error.message),
  );
  assert.throws(
    () => pacing.create({ parentRequestId: p.id, proposal: creative([{
      shotId: 'PACE_FORGE_A', durationFrames: 24, panelPath: '/tmp/forged.png',
    }]) }),
    (error) => error.status === 400 && /unsupported field panelPath/.test(error.message),
  );
});
