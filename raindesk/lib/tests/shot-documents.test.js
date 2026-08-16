'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-docs-'));
process.env.RAINDESK_DATA_DIR = scratch;
const blobs = require('../blobs');
const docs = require('../shot-documents');

const PNG_A = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const PNG_B = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,9,8,7]);

function doc(baseSha, genSha = null) {
  const layers = [
    { id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: baseSha },
    { id: 'L2', name: 'notes', kind: 'pen', visible: true, order: 1, assetSha: null,
      strokes: [{ id: 'st3', points: [{x:1,y:2},{x:3,y:4}], color:'#e07856', width:3 }] },
  ];
  if (genSha) layers.push({ id: 'L4', name: 'accepted take', kind: 'gen', visible: true, order: 2, strokes: [], assetSha: genSha });
  return { schemaVersion: 1, shotId: 'S01', canvas: { width: 64, height: 64 }, activeLayerId: genSha ? 'L4' : 'L2', layers };
}

test('shot documents create immutable revisions with optimistic concurrency', () => {
  const a = blobs.putPng(PNG_A);
  const b = blobs.putPng(PNG_B);
  const r1 = docs.save('S01', doc(a.sha), { reason: 'initial editable import' });
  assert.equal(r1.parentRevisionId, null);
  assert.equal(docs.readCurrent('S01').revisionId, r1.revisionId);

  const r2 = docs.save('S01', doc(a.sha, b.sha), { baseRevisionId: r1.revisionId, reason: 'accept take' });
  assert.equal(r2.parentRevisionId, r1.revisionId);
  assert.equal(docs.readCurrent('S01').revisionId, r2.revisionId);
  assert.equal(docs.readRevision('S01', r1.revisionId).document.layers.length, 2, 'old revision remains unchanged');
  assert.equal(docs.readRevision('S01', r2.revisionId).document.layers.length, 3);

  assert.throws(
    () => docs.save('S01', doc(a.sha), { baseRevisionId: r1.revisionId }),
    (e) => e.status === 409,
    'stale client cannot overwrite newer art',
  );
  const history = docs.list('S01');
  assert.equal(history.currentRevisionId, r2.revisionId);
  assert.deepEqual(history.revisions.map((r) => r.revisionId), [r2.revisionId, r1.revisionId]);
});

test('shot document validates raster references and vector-only strokes', () => {
  const a = blobs.putPng(PNG_A);
  const badMissing = doc(a.sha);
  badMissing.layers[0].assetSha = 'f'.repeat(64);
  assert.throws(() => docs.save('S02', { ...badMissing, shotId: 'S02' }), (e) => e.status === 400);

  const missingBytes = doc(a.sha);
  missingBytes.shotId = 'S02';
  missingBytes.layers[0].assetSha = null;
  assert.throws(() => docs.save('S02', missingBytes), (e) => e.status === 400);

  const badVector = doc(a.sha);
  badVector.shotId = 'S02';
  badVector.layers[1].assetSha = a.sha;
  assert.throws(() => docs.save('S02', badVector), (e) => e.status === 400);
});

test('restore creates a new current revision without rewriting either source or newer history', () => {
  const a = blobs.putPng(PNG_A);
  const initial = doc(a.sha); initial.shotId = 'RESTORE';
  const first = docs.save('RESTORE', initial, { reason: 'first' });
  const changed = doc(a.sha); changed.shotId = 'RESTORE';
  changed.layers[1].strokes.push({ id: 's2', points: [{ x: 3, y: 3 }, { x: 8, y: 9 }], color: '#ffffff', width: 2 });
  const second = docs.save('RESTORE', changed, { baseRevisionId: first.revisionId, reason: 'second' });

  const restored = docs.restore('RESTORE', first.revisionId, { baseRevisionId: second.revisionId, reason: 'go back' });
  assert.equal(restored.parentRevisionId, second.revisionId);
  assert.equal(restored.restoredFromRevisionId, first.revisionId);
  assert.deepEqual(restored.document, first.document);
  assert.equal(docs.readRevision('RESTORE', second.revisionId).document.layers[1].strokes.length, 2, 'newer revision stays immutable');
  assert.equal(docs.readCurrent('RESTORE').revisionId, restored.revisionId);
});
