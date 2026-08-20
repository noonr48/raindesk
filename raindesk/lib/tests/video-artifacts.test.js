'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-video-artifacts-'));
process.env.RAINDESK_DATA_DIR = scratch;

const { validateMp4Structure } = require('../mp4-structure');
const videoArtifacts = require('../video-artifacts');

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'animatic-tiny.mp4'));
const FTYP_ONLY = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(48, 7)]);
const NO_MOOV = Buffer.concat([
  Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'),
  Buffer.from([0, 0, 0, 8]), Buffer.from('free'),
]);

test('structural validator accepts the real fixture and reports its boxes', () => {
  const result = validateMp4Structure(FIXTURE);
  assert.equal(result.ok, true);
  assert.equal(result.boxes[0].type, 'ftyp');
  assert.ok(result.boxes.some((box) => box.type === 'moov'), 'moov box present');
});

test('structural validator rejects header-only ftyp fakes', () => {
  const result = validateMp4Structure(FTYP_ONLY);
  assert.equal(result.ok, false);
});

test('structural validator rejects truncated, tiny, moov-less and non-ftyp-first inputs', () => {
  assert.equal(validateMp4Structure(FIXTURE.subarray(0, 2000)).ok, false, 'truncated mid-box');
  assert.equal(validateMp4Structure(Buffer.alloc(4)).ok, false, 'below one header');
  assert.equal(validateMp4Structure(NO_MOOV).ok, false, 'no moov box');
  const wrongFirst = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('free'), Buffer.from([0, 0, 0, 16]), Buffer.from('moov')]);
  const r = validateMp4Structure(wrongFirst);
  assert.equal(r.ok, false);
  assert.match(r.reason, /first box is not ftyp/);
});

test('putMp4 enforces structural validity beyond the ftyp brand bytes', () => {
  const ok = videoArtifacts.putMp4(FIXTURE);
  assert.match(ok.sha, /^[a-f0-9]{64}$/);
  assert.equal(ok.bytes, FIXTURE.length);
  assert.throws(() => videoArtifacts.putMp4(FTYP_ONLY),
    (error) => error.status === 422 && /structurally valid MP4/.test(error.message));
});

test('streamMp4 imports with bounded memory and verifies manifest binding', () => {
  const file = path.join(scratch, 'real.mp4');
  fs.copyFileSync(path.join(__dirname, '..', '..', 'fixtures', 'animatic-tiny.mp4'), file);
  const item = videoArtifacts.streamMp4(file, {
    expectedSha: videoArtifacts.sha256(FIXTURE),
    expectedBytes: FIXTURE.length,
  });
  assert.equal(item.bytes, FIXTURE.length);
  assert.equal(item.mimeType, 'video/mp4');
  // Idempotent second import lands on the same content address.
  const again = videoArtifacts.streamMp4(file, {});
  assert.equal(again.sha, item.sha);
});

test('streamMp4 fails closed: symlink, oversize, hash mismatch, structural fake', () => {
  const real = path.join(scratch, 'real.mp4');
  const link = path.join(scratch, 'link.mp4');
  if (!fs.existsSync(link)) fs.symlinkSync(real, link);
  assert.throws(() => videoArtifacts.streamMp4(link),
    (error) => error.status === 422 && /symlink/.test(error.message));
  assert.throws(() => videoArtifacts.streamMp4(real, { maxBytes: 100 }),
    (error) => error.status === 413);
  assert.throws(() => videoArtifacts.streamMp4(real, { expectedSha: '0'.repeat(64) }),
    (error) => error.status === 422 && /hash does not match/.test(error.message));
  const fakeFile = path.join(scratch, 'ftyp-only.mp4');
  fs.writeFileSync(fakeFile, FTYP_ONLY);
  assert.throws(() => videoArtifacts.streamMp4(fakeFile),
    (error) => error.status === 422 && /structurally valid MP4/.test(error.message));
});
