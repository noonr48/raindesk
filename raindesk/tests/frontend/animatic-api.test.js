'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = require.resolve('../../public/js/animatic-api');

function loadExtension() {
  const calls = [];
  const stub = {
    GET(path) { calls.push({ method: 'GET', path }); return Promise.resolve({ ok: true }); },
    POST(path, payload) { calls.push({ method: 'POST', path, payload }); return Promise.resolve({ ok: true }); },
  };
  delete require.cache[MODULE_PATH];
  const previous = global.self;
  global.self = { RaindeskAPI: stub };
  const extension = require(MODULE_PATH);
  if (previous === undefined) delete global.self;
  else global.self = previous;
  return { extension, calls };
}

test('animatic API is reviewer-facing: digest reads, preview, polling, listing and review only', async () => {
  const { extension: api, calls } = loadExtension();
  // The internal construction powers (create pacing context / create pacing
  // proposal / raw prepare / raw execute) are NOT part of the browser
  // surface: context and proposal creation live behind the server-side
  // Partner boundary; preparation and approval happen only through Preview
  // this on a stored proposal digest.
  assert.equal(typeof api.createAnimaticPacingContext, 'undefined');
  assert.equal(typeof api.createAnimaticPacingProposal, 'undefined');
  assert.equal(typeof api.prepareAnimatic, 'undefined');
  assert.equal(typeof api.executeAnimatic, 'undefined');

  await api.getAnimaticPacingContext('a'.repeat(64));
  await api.getAnimaticPacingProposal('c'.repeat(64));
  await api.listAnimaticPacingProposals({ shotId: 'S01', sequenceId: 'scene-one', contextDigest: 'e'.repeat(64), limit: 9 });
  await api.previewAnimatic('f'.repeat(64));
  await api.getAnimaticPacingExecution('f'.repeat(64));

  assert.equal(calls[0].path, `/api/animatic/pacing-context/${'a'.repeat(64)}`);
  assert.equal(calls[1].path, `/api/animatic/pacing-proposal/${'c'.repeat(64)}`);
  assert.match(calls[2].path, /^\/api\/animatic\/pacing-proposals\?/);
  assert.match(calls[2].path, /shotId=S01/);
  assert.match(calls[2].path, /sequenceId=scene-one/);
  assert.match(calls[2].path, new RegExp(`contextDigest=${'e'.repeat(64)}`));
  assert.match(calls[2].path, /limit=9/);
  assert.deepEqual(calls[3], { method: 'POST', path: '/api/animatic/preview', payload: { proposalDigest: 'f'.repeat(64) } });
  assert.equal(calls[4].path, `/api/animatic/pacing-proposal/${'f'.repeat(64)}/execution`);
});

test('animatic API exposes execution polling, candidate listing and review without filesystem authority', async () => {
  const { extension: api, calls } = loadExtension();
  await api.getAnimaticExecution('exec_1');
  await api.listAnimaticCandidates({ sequenceId: 'scene-one', projectId: 'project', limit: 17 });
  await api.getAnimaticCandidate('candidate_1');
  await api.reviewAnimaticCandidate('candidate_1', 'keep', { note: 'this rhythm works', idempotencyKey: 'review-key' });
  await api.getAnimaticReview({ candidateId: 'candidate_1' });

  assert.equal(calls[0].path, '/api/animatic/execution/exec_1');
  assert.match(calls[1].path, /^\/api\/animatic\/candidates\?/);
  assert.match(calls[1].path, /sequenceId=scene-one/);
  assert.match(calls[1].path, /projectId=project/);
  assert.match(calls[1].path, /limit=17/);
  assert.equal(calls[2].path, '/api/animatic/candidate/candidate_1');
  assert.deepEqual(calls[3], {
    method: 'POST', path: '/api/animatic/review', payload: {
      candidateId: 'candidate_1', decision: 'keep', note: 'this rhythm works', idempotencyKey: 'review-key',
    },
  });
  assert.equal(calls[4].path, '/api/animatic/review?candidateId=candidate_1');
});

test('animatic review API requires caller idempotency and review scope', async () => {
  const { extension: api, calls } = loadExtension();
  await assert.rejects(() => api.reviewAnimaticCandidate('candidate_1', 'keep'), /idempotencyKey/);
  await assert.rejects(() => api.getAnimaticReview({}), /candidateId or sequenceId/);
  assert.equal(calls.length, 0, 'invalid browser review intent never reaches the network');
});
