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

test('animatic API keeps pacing authority on digest-bound server routes', async () => {
  const { extension: api, calls } = loadExtension();
  await api.createAnimaticPacingContext('invoke_parent');
  await api.getAnimaticPacingContext('a'.repeat(64));
  await api.createAnimaticPacingProposal('b'.repeat(64), {
    label: 'Restrained', fidelity: 'draft', shots: [{ shotId: 'S01', durationFrames: 48 }],
  });
  await api.getAnimaticPacingProposal('c'.repeat(64));
  await api.listAnimaticPacingProposals({ shotId: 'S01', sequenceId: 'scene-one', contextDigest: 'e'.repeat(64), limit: 9 });
  await api.prepareAnimatic('d'.repeat(64));
  await api.previewAnimatic('f'.repeat(64));

  assert.deepEqual(calls.slice(0, 4), [
    { method: 'POST', path: '/api/animatic/pacing-context', payload: { parentRequestId: 'invoke_parent' } },
    { method: 'GET', path: `/api/animatic/pacing-context/${'a'.repeat(64)}` },
    { method: 'POST', path: '/api/animatic/pacing-proposal', payload: {
      contextDigest: 'b'.repeat(64),
      proposal: { label: 'Restrained', fidelity: 'draft', shots: [{ shotId: 'S01', durationFrames: 48 }] },
    } },
    { method: 'GET', path: `/api/animatic/pacing-proposal/${'c'.repeat(64)}` },
  ]);
  assert.match(calls[4].path, /^\/api\/animatic\/pacing-proposals\?/);
  assert.match(calls[4].path, /shotId=S01/);
  assert.match(calls[4].path, /sequenceId=scene-one/);
  assert.match(calls[4].path, new RegExp(`contextDigest=${'e'.repeat(64)}`));
  assert.match(calls[4].path, /limit=9/);
  assert.deepEqual(calls[5], { method: 'POST', path: '/api/animatic/prepare', payload: { proposalDigest: 'd'.repeat(64) } });
  assert.deepEqual(calls[6], { method: 'POST', path: '/api/animatic/preview', payload: { proposalDigest: 'f'.repeat(64) } });
});

test('animatic API exposes execution, candidate listing and review without filesystem authority', async () => {
  const { extension: api, calls } = loadExtension();
  await api.executeAnimatic('animatic_request', { retry: true });
  await api.getAnimaticExecution('exec_1');
  await api.listAnimaticCandidates({ sequenceId: 'scene-one', projectId: 'project', limit: 17 });
  await api.getAnimaticCandidate('candidate_1');
  await api.reviewAnimaticCandidate('candidate_1', 'keep', { note: 'this rhythm works', idempotencyKey: 'review-key' });
  await api.getAnimaticReview({ candidateId: 'candidate_1' });

  assert.deepEqual(calls[0], {
    method: 'POST', path: '/api/animatic/execute', payload: { invocationId: 'animatic_request', retry: true },
  });
  assert.equal(calls[1].path, '/api/animatic/execution/exec_1');
  assert.match(calls[2].path, /^\/api\/animatic\/candidates\?/);
  assert.match(calls[2].path, /sequenceId=scene-one/);
  assert.match(calls[2].path, /projectId=project/);
  assert.match(calls[2].path, /limit=17/);
  assert.equal(calls[3].path, '/api/animatic/candidate/candidate_1');
  assert.deepEqual(calls[4], {
    method: 'POST', path: '/api/animatic/review', payload: {
      candidateId: 'candidate_1', decision: 'keep', note: 'this rhythm works', idempotencyKey: 'review-key',
    },
  });
  assert.equal(calls[5].path, '/api/animatic/review?candidateId=candidate_1');
});

test('animatic review API requires caller idempotency and review scope', async () => {
  const { extension: api, calls } = loadExtension();
  await assert.rejects(() => api.reviewAnimaticCandidate('candidate_1', 'keep'), /idempotencyKey/);
  await assert.rejects(() => api.getAnimaticReview({}), /candidateId or sequenceId/);
  assert.equal(calls.length, 0, 'invalid browser review intent never reaches the network');
});
