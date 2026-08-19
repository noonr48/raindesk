'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const preview = require('../animatic-preview');

function harness({ previous = null, stale = false, childStatus = 'proposed' } = {}) {
  const calls = [];
  const proposal = { proposalDigest: 'a'.repeat(64), parentRequestId: 'parent', shots: [{ shotId: 'S01' }] };
  const child = { id: 'child', status: childStatus };
  const service = preview.createPreviewService({
    pacingImpl: {
      readByDigest(digest) { calls.push(['read', digest]); return proposal; },
      freshness() { return { stale }; },
      snapshotInput() { return { shots: [{ shotId: 'S01', revisionId: 'rev1', durationFrames: 24 }] }; },
      publicProposal() { return { proposalDigest: proposal.proposalDigest, label: 'Restrained' }; },
    },
    preparationImpl: { prepare(args) { calls.push(['prepare', args]); return { invocation: child, snapshot: { snapshot_digest: 's'.repeat(64) } }; } },
    ledgerImpl: { setStatus(id, status) { calls.push(['status', id, status]); child.status = status; return child; } },
    executionStoreImpl: { latestForInvocation() { return previous; } },
    executorImpl: { async execute(id, options) { calls.push(['execute', id, options]); return { execution: { status: 'succeeded' }, candidate: { candidate: { candidate_id: 'cand1' } } }; } },
  });
  return { service, calls, child };
}

test('Preview this approves only the prepared exact child and renders that candidate', async () => {
  const { service, calls, child } = harness();
  const result = await service.preview({ proposalDigest: 'a'.repeat(64), sourceRights: 'artist-owned', env: { SAFE: 'yes' } });
  assert.equal(child.status, 'approved');
  assert.equal(result.candidate.candidate.candidate_id, 'cand1');
  assert.deepEqual(calls.find((row) => row[0] === 'status'), ['status', 'child', 'approved']);
  const execution = calls.find((row) => row[0] === 'execute');
  assert.equal(execution[1], 'child');
  assert.equal(execution[2].retry, false);
});

test('repeat after technical failure retries same prepared authority without creative mutation', async () => {
  const { service, calls } = harness({ previous: { status: 'failed' }, childStatus: 'handed_off' });
  const result = await service.preview({ proposalDigest: 'a'.repeat(64), sourceRights: 'artist-owned' });
  assert.equal(result.retried, true);
  assert.equal(calls.some((row) => row[0] === 'status'), false, 'handed-off child is not resurrected or re-approved');
  assert.equal(calls.find((row) => row[0] === 'execute')[2].retry, true);
});

test('stale, malformed and rights-free previews fail before execution', async () => {
  const stale = harness({ stale: true });
  await assert.rejects(() => stale.service.preview({ proposalDigest: 'a'.repeat(64), sourceRights: 'ok' }), (error) => error.status === 409);
  assert.equal(stale.calls.some((row) => row[0] === 'execute'), false);
  const clean = harness();
  await assert.rejects(() => clean.service.preview({ proposalDigest: 'not-a-digest', sourceRights: 'ok' }), (error) => error.status === 400);
  await assert.rejects(() => clean.service.preview({ proposalDigest: 'a'.repeat(64), sourceRights: '' }), (error) => error.status === 503);
});
