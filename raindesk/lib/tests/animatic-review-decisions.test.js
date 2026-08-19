'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-review-decisions-'));
process.env.RAINDESK_DATA_DIR = scratch;

const candidates = require('../animatic-candidates');
const review = require('../animatic-review-decisions');

function candidate(id, digest, importedAt) {
  return candidates.persist({
    schemaVersion: 1,
    invocationId: `invoke_${id}`,
    snapshotDigest: digest,
    importedAt,
    attempt: {
      schema_version: '0.2.0', attempt_id: `att_${id}`, source_snapshot_digest: digest,
      adapter_id: 'animatic_timing_v1', adapter_version: '0.2.0', lifecycle: 'succeeded',
      terminal_status: 'succeeded', started_at: null, ended_at: null, candidate_refs: [id], extensions: {},
    },
    candidate: {
      schema_version: '0.2.0', candidate_id: id, sequence_id: 'seq-review', project_id: 'project',
      attempt_id: `att_${id}`, source_snapshot_digest: digest,
      fidelity: { level: 'draft', note: 'test' }, files: [{ path: 'artifacts/animatic.mp4', sha256: 'f'.repeat(64), bytes: 12, mime_type: 'video/mp4' }],
      media: {}, provenance: {}, rights: {}, extensions: {},
    },
    artifacts: [{ sha: 'f'.repeat(64), bytes: 12, mimeType: 'video/mp4' }],
  });
}

const A = candidate('cand-review-a', 'a'.repeat(64), '2026-08-19T00:00:00.000Z');
const B = candidate('cand-review-b', 'b'.repeat(64), '2026-08-19T00:01:00.000Z');

test('Keep authority is append-only and a later Keep supersedes the prior sequence choice', () => {
  const a = review.append({ candidateId: A.candidate.candidate_id, decision: 'keep', idempotencyKey: 'keep-a' });
  assert.equal(a.created, true);
  assert.equal(a.decision.actor_id, 'owner');
  assert.equal(a.decision.actor_role, 'owner');
  assert.equal(a.summary.currentKeepCandidateId, A.candidate.candidate_id);

  const b = review.append({ candidateId: B.candidate.candidate_id, decision: 'keep', idempotencyKey: 'keep-b' });
  assert.equal(b.decision.supersedes_decision_id, a.decision.decision_id);
  assert.equal(b.summary.currentKeepCandidateId, B.candidate.candidate_id);
  assert.equal(review.read().decisions.length, 2);
});

test('idempotent browser retry cannot duplicate or broaden a review decision', () => {
  const first = review.append({ candidateId: B.candidate.candidate_id, decision: 'another', note: 'Try a longer hold.', idempotencyKey: 'another-b-1' });
  const replay = review.append({ candidateId: B.candidate.candidate_id, decision: 'another', note: 'Try a longer hold.', idempotencyKey: 'another-b-1' });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.decision.decision_id, first.decision.decision_id);
  assert.throws(() => review.append({
    candidateId: B.candidate.candidate_id, decision: 'reject', note: 'different content', idempotencyKey: 'another-b-1',
  }), (error) => error.status === 409);
});

test('candidate manifests remain immutable while review state is derived separately', () => {
  const before = JSON.stringify(candidates.read(A.candidate.candidate_id).candidate);
  review.append({ candidateId: A.candidate.candidate_id, decision: 'reject', idempotencyKey: 'reject-a' });
  const after = JSON.stringify(candidates.read(A.candidate.candidate_id).candidate);
  assert.equal(after, before);
  const summary = review.summaryForCandidate(A.candidate.candidate_id);
  assert.equal(summary.latestDecision.decision, 'reject');
  assert.equal(summary.isCurrentKeep, false);
});

test('Combine fails honestly until immutable candidate-bound ReviewAnnotations exist', () => {
  assert.throws(() => review.append({
    candidateId: A.candidate.candidate_id, decision: 'combine', note: 'use the opening from A', idempotencyKey: 'combine-a',
  }), (error) => error.status === 409 && /review notes|ReviewAnnotation/i.test(error.message));
  assert.throws(() => review.append({
    candidateId: A.candidate.candidate_id, decision: 'keep', annotationRefs: ['direction_ann_1'], idempotencyKey: 'fake-review-ref',
  }), (error) => error.status === 409 && /ReviewAnnotation/i.test(error.message));
});
