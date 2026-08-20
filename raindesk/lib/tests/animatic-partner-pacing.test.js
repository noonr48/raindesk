'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const compose = require('../animatic-partner-pacing');

function request() {
  return {
    id: 'invoke_animatic', adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
  };
}

test('completed animatic Partner turn gets stored server-bound pacing alternatives', async () => {
  const calls = [];
  const context = { contextDigest: 'a'.repeat(64), activeShotId: 'S01', eligibleShots: [{ shotId: 'S01' }] };
  const result = await compose.enrichTurn({ message: 'I can show two rhythms.', invocationRequests: [request()] }, {
    input: { message: 'let this breathe longer' },
    env: { TEST: '1' },
    advisor: { async suggest(args) { calls.push(['suggest', args]); return { proposals: [{ label: 'Restrained', shots: [{ shotId: 'S01', durationFrames: 48 }] }] }; } },
    pacingContextImpl: {
      create(args) { calls.push(['context', args]); return { context, created: true }; },
      publicContext(value) { return { contextDigest: value.contextDigest, activeShotId: value.activeShotId }; },
    },
    pacingImpl: {
      createFromContext(args) { calls.push(['proposal', args]); return { proposal: { ...args.proposal, proposalDigest: 'b'.repeat(64) } }; },
      publicProposal(value) { return value; },
    },
  });
  assert.equal(result.animaticPacingProposals.length, 1);
  assert.equal(result.animaticPacingProposals[0].label, 'Restrained');
  assert.equal(result.animaticPacingContext.contextDigest, 'a'.repeat(64));
  assert.equal(calls[0][0], 'context');
  assert.equal(calls[1][0], 'suggest');
  assert.equal(calls[1][1].artistMessage, 'let this breathe longer');
  assert.equal(calls[2][0], 'proposal');
  assert.equal(calls[2][1].contextDigest, 'a'.repeat(64));
});

test('ordinary Partner turn is untouched and pacing failure never strands conversation', async () => {
  const ordinary = { message: 'keep drawing', invocationRequests: [] };
  assert.equal(await compose.enrichTurn(ordinary, { advisor: { suggest: async () => ({ proposals: [] }) } }), ordinary);
  const failed = await compose.enrichTurn({ message: 'still here', invocationRequests: [request()] }, {
    advisor: { async suggest() { throw new Error('model unavailable'); } },
    pacingContextImpl: { create() { return { context: { contextDigest: 'a'.repeat(64) } }; } },
  });
  assert.equal(failed.message, 'still here');
  assert.deepEqual(failed.animaticPacingProposals, []);
  assert.equal(failed.animaticPacingSuggestionError, true);
});
