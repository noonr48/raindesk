'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-job-store-'));
process.env.RAINDESK_DATA_DIR = scratch;
const jobs = require('../../lib/job-store');

test('job store persists stage/status metadata and filters by shot', () => {
  jobs.upsert({ id: '1', status: 'pending', phase: 'queued', meta: { shotId: 'S01' }, createdAt: 1 });
  jobs.upsert({ id: '1', status: 'done', phase: 'complete', meta: { shotId: 'S01' }, createdAt: 1, finishedAt: 2, imageUrl: '/x.png', takeId: 'take_S01_1', resultAssetSha: 'a'.repeat(64), comfyUrl: 'http://comfy/view' });
  jobs.upsert({ id: '2', status: 'done', phase: 'complete', meta: { shotId: 'S02' } });
  assert.equal(jobs.get('1').imageUrl, '/x.png');
  assert.equal(jobs.get('1').takeId, 'take_S01_1');
  assert.equal(jobs.get('1').resultAssetSha, 'a'.repeat(64));
  assert.deepEqual(jobs.list({ shotId: 'S01' }).map((j) => j.id), ['1']);
});

test('startup recovery marks abandoned pending jobs honestly as interrupted', () => {
  jobs.upsert({ id: '3', status: 'pending', phase: 'generating', meta: { shotId: 'S03' } });
  assert.equal(jobs.recoverInterrupted(), 1);
  assert.equal(jobs.get('3').status, 'error');
  assert.equal(jobs.get('3').phase, 'interrupted');
});
