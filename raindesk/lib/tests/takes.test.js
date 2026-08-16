'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-takes-'));
process.env.RAINDESK_DATA_DIR = scratch;
const takes = require('../takes');

test('generated take provenance persists independently from editable shot revisions', () => {
  const t = takes.createCandidate({
    shotId: 'S03', jobId: '17', prompt: 'push the camera lower', seed: 4,
    baseRevisionId: 'rev_before', sourceRegionAssetSha: 'a'.repeat(64),
    maskAssetSha: 'b'.repeat(64), resultAssetSha: 'c'.repeat(64),
    region: { x: 10, y: 20, w: 300, h: 200 },
    lasso: [{ x: 11, y: 22 }, { x: 50, y: 80 }],
  });
  assert.equal(t.status, 'candidate');
  assert.equal(t.baseRevisionId, 'rev_before');
  assert.equal(takes.list({ shotId: 'S03' })[0].resultAssetSha, 'c'.repeat(64));

  const accepted = takes.setStatus(t.id, 'accepted', { revisionId: 'rev_after' });
  assert.equal(accepted.acceptedRevisionId, 'rev_after');
  assert.equal(takes.get(t.id).status, 'accepted');
  const reopened = takes.setStatus(t.id, 'candidate');
  assert.equal(reopened.acceptedRevisionId, null);
  assert.equal(reopened.status, 'candidate');
});

test('take store rejects candidates without a durable local result asset', () => {
  assert.throws(() => takes.createCandidate({ shotId: 'S01', jobId: '1' }), (e) => e.status === 400);
  assert.throws(() => takes.setStatus('missing', 'accepted'), (e) => e.status === 404);
});
