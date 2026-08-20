'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-server-proposals-'));
process.env.RAINDESK_DATA_DIR = scratch;

const ledger = require('../partner-invocation-ledger');
const server = require('../../server');

function request(id = 'invoke_server_proposal') {
  return {
    schemaVersion: 1,
    id,
    turnId: 'turn_server_proposal',
    stageId: 'animatic_pass:2:animatic_timing',
    recipeId: 'animatic_pass',
    capabilityId: 'animatic_timing',
    adapterId: 'animatic_timing_v1',
    invocationBoundary: 'external',
    disposition: 'proposal',
    status: 'awaiting_approval',
    reviewRequired: true,
    creativeMutation: true,
    scope: { shotId: 'S01', artRevisionId: 'rev_server_1', selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'],
    requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'],
    sideEffects: ['creates_animatic_candidate'],
  };
}

test('actionable Partner requests are server-recorded as proposals before browser exposure', async () => {
  const req = request();
  const wrapped = server.withAuthoritativeContext({
    turn: async () => ({ reply: 'I can make a preview.', invocationRequests: [req] }),
  });
  const result = await wrapped.turn({ context: { shotId: 'S01' } });
  assert.equal(result.invocationRequests.length, 1);
  const row = ledger.find(ledger.read(), req.id);
  assert.ok(row);
  assert.equal(row.status, 'proposed');
  assert.equal(row.adapterId, 'animatic_timing_v1');
  assert.equal(row.scope.artRevisionId, 'rev_server_1');
});

test('proposal persistence failure withholds browser actionability while preserving conversation', async () => {
  const original = ledger.recordFromRequest;
  const oldError = console.error;
  ledger.recordFromRequest = () => { throw new Error('simulated ledger outage'); };
  console.error = () => {};
  try {
    const wrapped = server.withAuthoritativeContext({
      turn: async () => ({ reply: 'we can still talk', invocationRequests: [request('invoke_outage')] }),
    });
    const result = await wrapped.turn({ context: { shotId: 'S01' } });
    assert.equal(result.reply, 'we can still talk');
    assert.deepEqual(result.invocationRequests, []);
    assert.equal(result.invocationPersistenceError, true);
  } finally {
    ledger.recordFromRequest = original;
    console.error = oldError;
  }
});
