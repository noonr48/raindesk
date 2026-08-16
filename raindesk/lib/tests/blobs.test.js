'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-blobs-'));
process.env.RAINDESK_DATA_DIR = scratch;
const blobs = require('../blobs');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('content-addressed PNG blobs deduplicate and resolve by sha', () => {
  const a = blobs.putPng(PNG);
  const b = blobs.putPng(PNG);
  assert.match(a.sha, /^[a-f0-9]{64}$/);
  assert.equal(a.sha, b.sha, 'identical bytes share one immutable blob');
  assert.equal(a.url, `/api/blob/${a.sha}`);
  assert.ok(blobs.exists(a.sha));
  assert.deepEqual(fs.readFileSync(blobs.resolve(a.sha)), PNG);
  assert.equal(fs.readdirSync(blobs.BLOB_DIR).length, 1, 'dedup leaves one file');
});

test('blob store rejects bad content and bad sha', () => {
  assert.throws(() => blobs.putPng(Buffer.from('not png')), (e) => e.status === 400);
  assert.equal(blobs.resolve('../escape'), null);
  assert.throws(() => blobs.blobPath('nope'), (e) => e.status === 400);
});
