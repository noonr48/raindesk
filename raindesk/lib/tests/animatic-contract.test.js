'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../animatic-contract');
const pacing = require('../animatic-pacing-proposals');
const snapshots = require('../animatic-snapshots');

test('pacing proposals and snapshots share one animatic validation envelope', () => {
  assert.equal(pacing.ID_RE, contract.CONTRACT_ID_RE);
  assert.equal(snapshots.CONTRACT_ID_RE, contract.CONTRACT_ID_RE);
  assert.equal(pacing.MAX_SHOTS, contract.MAX_SHOTS);
  assert.equal(snapshots.MAX_SHOTS, contract.MAX_SHOTS);
  assert.equal(pacing.MAX_DURATION_FRAMES, contract.MAX_DURATION_FRAMES);
  assert.equal(snapshots.MAX_DURATION_FRAMES, contract.MAX_DURATION_FRAMES);
  assert.equal(pacing.FIDELITIES, contract.FIDELITIES);
  assert.equal(snapshots.FIDELITIES, contract.FIDELITIES);
});

test('fractional film/video frame rates are accepted consistently at the proposal boundary', () => {
  const normalized = pacing.normalizeCreative({
    projectId: 'project-1',
    sequenceId: 'sequence-1',
    fpsNum: 24000,
    fpsDen: 1001,
    fidelity: 'draft',
    label: 'fractional rate',
    rationale: '',
    shots: [{ shotId: 'S01', durationFrames: 24, note: null }],
  });
  assert.equal(normalized.fpsNum, 24000);
  assert.equal(normalized.fpsDen, 1001);
  assert.deepEqual(pacing.timeValue(24, 24000, 1001), { num: 1001, den: 1000 });
});

test('ids and durations rejected by the snapshot envelope are rejected before proposal persistence', () => {
  assert.throws(() => pacing.normalizeCreative({
    projectId: 'p'.repeat(161),
    sequenceId: 'sequence-1',
    fpsNum: 24,
    fpsDen: 1,
    fidelity: 'draft',
    shots: [{ shotId: 'S01', durationFrames: 24 }],
  }), /projectId is invalid/);

  assert.throws(() => pacing.normalizeCreative({
    projectId: 'project-1',
    sequenceId: 'sequence-1',
    fpsNum: 24,
    fpsDen: 1,
    fidelity: 'draft',
    shots: [{ shotId: 'S01', durationFrames: contract.MAX_DURATION_FRAMES + 1 }],
  }), /positive bounded integer/);
});
