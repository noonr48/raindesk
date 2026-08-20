'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-server-pacing-advice-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const direction = require('../direction');
const ledger = require('../partner-invocation-ledger');
const pacing = require('../animatic-pacing-proposals');
const server = require('../../server');

function png() {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([40, 70, 90, 255], i * 4);
  return Buffer.from(Canvas.encodePNG(8, 8, data));
}

function seed() {
  const asset = blobs.putPng(png());
  const revision = docs.save('PACE_SERVER_A', {
    schemaVersion: 1, shotId: 'PACE_SERVER_A', canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'server pacing fixture' });
  direction.ensureLegacyShot('PACE_SERVER_A', { title: 'Slope wide', beat: 'Lena sees the wheel slip.' });
  return revision;
}

function request(revisionId) {
  return {
    schemaVersion: 1,
    id: 'invoke_server_pacing_advice',
    turnId: 'turn_server_pacing_advice',
    stageId: 'animatic_pass:2:animatic_timing',
    recipeId: 'animatic_pass',
    capabilityId: 'animatic_timing',
    adapterId: 'animatic_timing_v1',
    invocationBoundary: 'external',
    disposition: 'proposal',
    status: 'awaiting_approval',
    reviewRequired: true,
    creativeMutation: true,
    scope: { shotId: 'PACE_SERVER_A', artRevisionId: revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'],
    requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'],
    preserves: ['accepted_sequence_until_review'],
    sideEffects: ['creates_animatic_candidate'],
  };
}

test('server persists coarse authority before asking the pacing advisor and stores returned creative advice', async () => {
  const revision = seed();
  let advisorCalls = 0;
  const advisor = {
    async suggest({ context, artistMessage, partnerMessage }) {
      advisorCalls += 1;
      assert.ok(ledger.find(ledger.read(), 'invoke_server_pacing_advice'), 'coarse invocation exists before second-pass advice');
      assert.equal(context.activeShotId, 'PACE_SERVER_A');
      assert.equal(context.eligibleShots[0].artworkRevisionId, revision.revisionId);
      assert.equal(artistMessage, 'make this breathe a little longer');
      assert.equal(partnerMessage, 'I can give you a couple of rhythms.');
      return {
        proposals: [{
          label: 'Restrained', rationale: 'Let the realization land.', fidelity: 'draft',
          shots: [{ shotId: 'PACE_SERVER_A', durationFrames: 60, note: 'hold on the realization' }],
        }],
      };
    },
  };
  const wrapped = server.withAuthoritativeContext({
    turn: async () => ({
      message: 'I can give you a couple of rhythms.',
      turnId: 'turn_server_pacing_advice',
      invocationRequests: [request(revision.revisionId)],
    }),
  }, { pacingAdvisor: advisor, animaticEnv: { RAINDESK_ANIMATIC_FPS_NUM: '24', RAINDESK_ANIMATIC_FPS_DEN: '1' } });

  const result = await wrapped.turn({
    message: 'make this breathe a little longer',
    context: { shotId: 'PACE_SERVER_A', artRevisionId: 'browser-forged-revision' },
  });
  assert.equal(advisorCalls, 1);
  assert.equal(result.animaticPacingProposals.length, 1);
  assert.equal(result.animaticPacingProposals[0].label, 'Restrained');
  assert.equal(result.animaticPacingProposals[0].shots[0].durationFrames, 60);
  assert.equal(result.animaticPacingProposals[0].shots[0].revisionId, undefined, 'public creative offer hides source revision authority');
  const stored = pacing.readByDigest(result.animaticPacingProposals[0].proposalDigest);
  assert.equal(stored.shots[0].revisionId, revision.revisionId, 'stored proposal is rebound to server source authority');
  assert.match(stored.contextDigest, /^[a-f0-9]{64}$/);
});

test('pacing second-pass failure preserves normal Partner response and coarse proposal', async () => {
  const current = docs.readCurrent('PACE_SERVER_A') || seed();
  const req = { ...request(current.revisionId), id: 'invoke_server_pacing_failure', turnId: 'turn_server_pacing_failure' };
  const wrapped = server.withAuthoritativeContext({
    turn: async () => ({ message: 'the directing conversation still works', invocationRequests: [req] }),
  }, {
    pacingAdvisor: { async suggest() { throw new Error('temporary pacing model failure'); } },
    animaticEnv: { RAINDESK_ANIMATIC_FPS_NUM: '24', RAINDESK_ANIMATIC_FPS_DEN: '1' },
  });
  const result = await wrapped.turn({ message: 'try a rhythm', context: { shotId: 'PACE_SERVER_A' } });
  assert.equal(result.message, 'the directing conversation still works');
  assert.deepEqual(result.animaticPacingProposals, []);
  assert.equal(result.animaticPacingSuggestionError, true);
  assert.ok(ledger.find(ledger.read(), req.id));
});
