'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-snapshots-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const direction = require('../direction');
const projection = require('../shot-projection');
const snapshots = require('../animatic-snapshots');

function solidPng(width, height, rgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Buffer.from(Canvas.encodePNG(width, height, data));
}

function makeDocument(shotId, baseSha, { width = 8, height = 8, stroke = false } = {}) {
  const layers = [{
    id: 'L1', name: 'base', kind: 'base', visible: true, order: 0,
    strokes: [], assetSha: baseSha,
  }];
  if (stroke) {
    layers.push({
      id: 'L2', name: 'direction ink', kind: 'pen', visible: true, order: 1, assetSha: null,
      strokes: [{ id: 'st1', points: [{ x: 1, y: 1 }, { x: 6, y: 1 }], color: '#ff0000', width: 2 }],
    });
  }
  return { schemaVersion: 1, shotId, canvas: { width, height }, activeLayerId: layers.at(-1).id, layers };
}

function createShot(shotId, rgba, options = {}) {
  const png = solidPng(options.width || 8, options.height || 8, rgba);
  const stored = blobs.putPng(png);
  const revision = docs.save(shotId, makeDocument(shotId, stored.sha, options), { reason: 'test source' });
  direction.ensureLegacyShot(shotId, { title: shotId, beat: `direction for ${shotId}` });
  return { stored, revision };
}

function request(shots, patch = {}) {
  return {
    projectId: 'after-last-rain',
    sequenceId: 'seq-test',
    fpsNum: 24,
    fpsDen: 1,
    fidelity: 'draft',
    sourceRights: 'raindesk-owner-artwork',
    shots,
    ...patch,
  };
}

test('server-side revision projection composes immutable raster and vector layers', () => {
  const { revision } = createShot('PROJ', [10, 20, 30, 255], { stroke: true });
  const panel = projection.projectRevision('PROJ', revision.revisionId);
  assert.equal(panel.width, 8);
  assert.equal(panel.height, 8);
  assert.equal(panel.revisionId, revision.revisionId);
  assert.equal(crypto.createHash('sha256').update(panel.png).digest('hex'), panel.panelSha);

  const decoded = Canvas.decodePNG(panel.png);
  const base = (7 * 8 + 7) * 4;
  assert.deepEqual(Array.from(decoded.data.slice(base, base + 4)), [10, 20, 30, 255]);
  const ink = (1 * 8 + 3) * 4;
  assert.ok(decoded.data[ink] > decoded.data[ink + 1], 'vector stroke is replayed over the raster source');
});

test('snapshot compiler binds explicit order, timing, exact revisions and redacts local paths publicly', () => {
  const a = createShot('ORDER_A', [25, 50, 75, 255]);
  const b = createShot('ORDER_B', [90, 80, 70, 255]);
  const input = request([
    { shotId: 'ORDER_B', revisionId: b.revision.revisionId, durationFrames: 18 },
    { shotId: 'ORDER_A', revisionId: a.revision.revisionId, durationFrames: 31 },
  ]);
  const first = snapshots.compile(input);
  const second = snapshots.compile(input);

  assert.equal(first.snapshot_digest, second.snapshot_digest, 'same source state is deterministic');
  assert.deepEqual(first.shots.map((shot) => shot.shot_id), ['ORDER_B', 'ORDER_A']);
  assert.deepEqual(first.shots.map((shot) => shot.duration_frames), [18, 31]);
  assert.equal(first.shots[0].artwork_revision_id, b.revision.revisionId);
  assert.equal(first.shots[0].panel_sha256, path.basename(first.shots[0].panel_path, '.png'));
  assert.ok(fs.existsSync(first.shots[0].panel_path));
  assert.deepEqual(snapshots.read(first.snapshot_digest), first);

  const publicView = snapshots.publicSummary(first);
  assert.equal(Object.prototype.hasOwnProperty.call(publicView.shots[0], 'panel_path'), false);
  assert.equal(JSON.stringify(publicView).includes(scratch), false, 'filesystem root never leaks through the public summary');
});

test('snapshot digest is sensitive to explicit timing, ordering and bounded creative state', () => {
  const a = createShot('DIGEST_A', [1, 2, 3, 255]);
  const b = createShot('DIGEST_B', [4, 5, 6, 255]);
  const baseShots = [
    { shotId: 'DIGEST_A', revisionId: a.revision.revisionId, durationFrames: 12 },
    { shotId: 'DIGEST_B', revisionId: b.revision.revisionId, durationFrames: 20 },
  ];
  const base = snapshots.compile(request(baseShots, { sequenceId: 'digest-seq' }));
  const timing = snapshots.compile(request([
    { ...baseShots[0], durationFrames: 13 }, baseShots[1],
  ], { sequenceId: 'digest-seq' }));
  const reordered = snapshots.compile(request([baseShots[1], baseShots[0]], { sequenceId: 'digest-seq' }));
  assert.notEqual(base.snapshot_digest, timing.snapshot_digest);
  assert.notEqual(base.snapshot_digest, reordered.snapshot_digest);

  direction.setShotConstraints('DIGEST_A', { preserve: ['keep this silhouette'] });
  const creative = snapshots.compile(request(baseShots, { sequenceId: 'digest-seq' }));
  assert.notEqual(base.shots[0].creative_state_digest, creative.shots[0].creative_state_digest);
  assert.notEqual(base.snapshot_digest, creative.snapshot_digest);
});

test('explicit old artwork revision remains usable while current revision projects independently', () => {
  const firstBase = blobs.putPng(solidPng(8, 8, [20, 30, 40, 255]));
  const first = docs.save('OLDREV', makeDocument('OLDREV', firstBase.sha), { reason: 'first' });
  direction.ensureLegacyShot('OLDREV', { beat: 'old revision test' });
  const nextBase = blobs.putPng(solidPng(8, 8, [120, 130, 140, 255]));
  const second = docs.save('OLDREV', makeDocument('OLDREV', nextBase.sha), {
    baseRevisionId: first.revisionId, reason: 'second',
  });

  const oldSnap = snapshots.compile(request([
    { shotId: 'OLDREV', revisionId: first.revisionId, durationFrames: 10 },
  ], { sequenceId: 'old-rev' }));
  const currentSnap = snapshots.compile(request([
    { shotId: 'OLDREV', durationFrames: 10 },
  ], { sequenceId: 'old-rev' }));
  assert.equal(oldSnap.shots[0].artwork_revision_id, first.revisionId);
  assert.equal(currentSnap.shots[0].artwork_revision_id, second.revisionId);
  assert.notEqual(oldSnap.shots[0].panel_sha256, currentSnap.shots[0].panel_sha256);
  assert.notEqual(oldSnap.snapshot_digest, currentSnap.snapshot_digest);
});

test('snapshot compilation fails closed on missing/stale inputs, duplicate ids, corruption and size mismatch', () => {
  assert.throws(
    () => snapshots.compile(request([{ shotId: 'MISSING', revisionId: 'rev_not_real_1234', durationFrames: 10 }])),
    (error) => error.status === 404,
  );

  const duplicate = createShot('DUPLICATE', [10, 10, 10, 255]);
  assert.throws(() => snapshots.compile(request([
    { shotId: 'DUPLICATE', revisionId: duplicate.revision.revisionId, durationFrames: 10 },
    { shotId: 'DUPLICATE', revisionId: duplicate.revision.revisionId, durationFrames: 11 },
  ])), (error) => error.status === 400);

  const corrupt = createShot('CORRUPT', [30, 30, 30, 255]);
  fs.writeFileSync(blobs.blobPath(corrupt.stored.sha), Buffer.from('corrupt'));
  assert.throws(
    () => snapshots.compile(request([{ shotId: 'CORRUPT', revisionId: corrupt.revision.revisionId, durationFrames: 10 }])),
    (error) => error.status === 500 && /content hash/.test(error.message),
  );

  const small = blobs.putPng(solidPng(4, 4, [40, 40, 40, 255]));
  const badDoc = makeDocument('WRONGSIZE', small.sha, { width: 8, height: 8 });
  const wrong = docs.save('WRONGSIZE', badDoc, { reason: 'wrong pixel dimensions' });
  direction.ensureLegacyShot('WRONGSIZE', { beat: 'wrong size' });
  assert.throws(
    () => snapshots.compile(request([{ shotId: 'WRONGSIZE', revisionId: wrong.revisionId, durationFrames: 10 }])),
    (error) => error.status === 500 && /dimensions/.test(error.message),
  );
});
