'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-invocation-v2-'));
process.env.RAINDESK_DATA_DIR = scratch;
const ledgerPath = path.join(scratch, 'invocation-ledger.json');

fs.writeFileSync(ledgerPath, JSON.stringify({
  schemaVersion: 1,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:01:00.000Z',
  invocations: [{
    id: 'legacy_1', requestId: 'legacy_1', turnId: 'turn_old', shotId: 'S01',
    adapterId: 'bounded_image_region_v1', capabilityId: 'local_image_take',
    status: 'approved', approvedAt: '2026-08-18T00:01:00.000Z', recordedAt: '2026-08-18T00:00:30.000Z',
  }],
}, null, 2));

const ledger = require('../partner-invocation-ledger');

function bounded(id, adapterId = 'bounded_image_region_v1') {
  const animatic = adapterId === 'animatic_timing_v1';
  return {
    id, requestId: id, turnId: `turn_${id}`, shotId: 'S01',
    adapterId,
    capabilityId: animatic ? 'animatic_timing' : 'local_image_take',
    stageId: `recipe:1:${adapterId}`, recipeId: animatic ? 'animatic_pass' : 'local_refinement',
    invocationBoundary: animatic ? 'external' : 'surface',
    disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: {
      shotId: 'S01', artRevisionId: 'rev_authoritative_1',
      selectionFingerprint: 'f'.repeat(24),
      selectionStable: { type: 'lasso', points: [{ x: 1, y: 2 }, { x: 4, y: 8 }] },
    },
    requiredEvidence: ['shot_scope'],
    requiredInputs: ['shot_id'],
    expectedOutputs: ['candidate_take'],
    preserves: ['accepted_artwork'],
    sideEffects: ['creates_candidate'],
    status: 'proposed',
  };
}

test('v1 ledger migrates to v2 without inventing frozen authority', () => {
  const store = ledger.read();
  assert.equal(store.schemaVersion, 2);
  assert.equal(store.invocations.length, 1);
  const old = store.invocations[0];
  assert.equal(old.id, 'legacy_1');
  assert.equal(old.status, 'approved');
  assert.equal(old.approvedAt, '2026-08-18T00:01:00.000Z');
  assert.equal(old.scope, null, 'v1 history cannot acquire a scope it never recorded');
  assert.equal(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).schemaVersion, 2, 'migration persists');
});

test('v2 record persists exact bounded authority and idempotent replay cannot mutate it', () => {
  const input = bounded('invoke_v2');
  const first = ledger.record(input);
  assert.equal(first.created, true);
  assert.equal(first.entry.scope.artRevisionId, 'rev_authoritative_1');
  assert.deepEqual(first.entry.scope.selectionStable.points, [{ x: 1, y: 2 }, { x: 4, y: 8 }]);
  assert.deepEqual(first.entry.requiredInputs, ['shot_id']);

  const replay = ledger.record({ id: 'invoke_v2', status: 'approved' });
  assert.equal(replay.created, false);
  assert.equal(replay.entry.status, 'proposed', 'POST replay does not mutate lifecycle');
  assert.throws(
    () => ledger.record({ id: 'invoke_v2', adapterId: 'animatic_timing_v1' }),
    (error) => error.status === 409,
    'same id cannot be rebound to materially different authority',
  );
});

test('supersession is adapter-scoped when v2 adapter identity is present', () => {
  ledger.record(bounded('image_old'));
  ledger.record(bounded('animatic_pending', 'animatic_timing_v1'));
  ledger.record(bounded('image_new'));
  const marked = ledger.markStaleSuperseded({
    shotId: 'S01', requestId: 'image_new', adapterId: 'bounded_image_region_v1',
  });
  assert.ok(marked >= 1);
  const store = ledger.read();
  assert.equal(ledger.find(store, 'image_old').status, 'stale');
  assert.equal(ledger.find(store, 'animatic_pending').status, 'proposed', 'different adapter remains independently pending');
  assert.equal(ledger.find(store, 'image_new').status, 'proposed');
});
