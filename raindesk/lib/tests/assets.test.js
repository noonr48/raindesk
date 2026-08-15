'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Scratch data dir BEFORE requiring the module (same pattern as shots.js).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-assets-'));
process.env.RAINDESK_DATA_DIR = scratch;

const assets = require('../../lib/assets');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('take-bytes'),
]);

test('store returns a same-origin /api/assets URL and the bytes round-trip from disk', () => {
  const { file, url } = assets.store('S01', PNG);
  assert.match(url, /^\/api\/assets\/S01\//);
  assert.match(file, /\.png$/);
  const p = assets.resolve('S01', file);
  assert.ok(p, 'resolve finds the stored file');
  assert.ok(fs.readFileSync(p).equals(PNG), 'bytes round-trip');
});

test('resolve rejects traversal, bad ids, and bad filenames', () => {
  assert.equal(assets.resolve('S01', '../../etc/passwd'), null);
  assert.equal(assets.resolve('S01', '..\\..\\x'), null);
  assert.equal(assets.resolve('../evil', 'a.png'), null);
  assert.equal(assets.resolve('bad id!', 'a.png'), null);
  assert.equal(assets.resolve('S01', 'no/such/file.png'), null, 'path separators rejected');
});

test('store rejects bad input early', () => {
  assert.throws(() => assets.store('bad id!', PNG));
  assert.throws(() => assets.store('S01', Buffer.from('tiny')));
});
