'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-sheets-'));
process.env.RAINDESK_DATA_DIR = scratch;
const sheets = require('../sheet-documents');

function doc(id, strokes = [], title = 'Loose sketch') {
  return { schemaVersion: 1, sheetId: id, title, kind: 'sketch', canvas: { width: 700, height: 900 }, media: [], strokes, meta: {} };
}
function stroke(id, x = 10) {
  return { id, color: '#333333', width: 2.4, points: [{ x, y: 20 }, { x: x + 25, y: 45 }] };
}

test('creative sheet creates an immutable first revision and appears in summaries', () => {
  const created = sheets.create({ sheetId: 'sheet_first', title: 'Gesture ideas', kind: 'sketch' });
  assert.match(created.revisionId, /^srev_/);
  assert.equal(created.document.title, 'Gesture ideas');
  assert.equal(created.document.strokes.length, 0);
  const listed = sheets.list().find((s) => s.sheetId === 'sheet_first');
  assert.equal(listed.title, 'Gesture ideas');
  assert.equal(listed.strokeCount, 0);
});

test('sheet saves use optimistic concurrency and previous revisions remain byte-stable', () => {
  const initial = sheets.create({ sheetId: 'sheet_revision', title: 'Acting beats' });
  const saved = sheets.save('sheet_revision', doc('sheet_revision', [stroke('a')], 'Acting beats'), {
    baseRevisionId: initial.revisionId, reason: 'draw stroke',
  });
  assert.notEqual(saved.revisionId, initial.revisionId);
  assert.equal(sheets.readRevision('sheet_revision', initial.revisionId).document.strokes.length, 0);
  assert.equal(sheets.readCurrent('sheet_revision').document.strokes.length, 1);
  assert.throws(() => sheets.save('sheet_revision', doc('sheet_revision', [stroke('b')]), {
    baseRevisionId: initial.revisionId,
  }), /changed since this edit/);
});

test('sheet title and vector state can advance together without rewriting history', () => {
  const initial = sheets.create({ sheetId: 'sheet_title', title: 'Loose sketch' });
  const next = sheets.save('sheet_title', doc('sheet_title', [stroke('a')], 'Rooftop hand studies'), {
    baseRevisionId: initial.revisionId, reason: 'rename and draw',
  });
  assert.equal(next.document.title, 'Rooftop hand studies');
  assert.equal(sheets.readRevision('sheet_title', initial.revisionId).document.title, 'Loose sketch');
  assert.equal(sheets.history('sheet_title').revisions.length, 2);
});


test('reference media cards are revisioned with the sheet and summaries stay bounded', () => {
  const initial = sheets.create({ sheetId: 'sheet_refs', title: 'Refs', kind: 'references' });
  const document = { ...initial.document, media: [{
    id: 'ref_1', kind: 'image', sha: 'a'.repeat(64), x: 30, y: 40, width: 280, height: 180, rotation: -4, opacity: 0.8, zIndex: 2, caption: 'roofline',
  }] };
  const saved = sheets.save('sheet_refs', document, { baseRevisionId: initial.revisionId, reason: 'add reference' });
  assert.equal(saved.document.media.length, 1);
  assert.equal(saved.document.media[0].sha, 'a'.repeat(64));
  assert.equal(sheets.readRevision('sheet_refs', initial.revisionId).document.media.length, 0);
  const listed = sheets.list().find((item) => item.sheetId === 'sheet_refs');
  assert.equal(listed.mediaCount, 1);
  assert.throws(() => sheets.save('sheet_refs', { ...saved.document, media: [{ kind: 'image', sha: 'bad' }] }, { baseRevisionId: saved.revisionId }), /bad blob sha/);
  assert.throws(() => sheets.validateDocument('sheet_refs', { ...saved.document, media: [saved.document.media[0], { ...saved.document.media[0] }] }), /media ids must be unique/);
});

test('sheet validation rejects malformed and unbounded vector input', () => {
  const initial = sheets.create({ sheetId: 'sheet_bad' });
  assert.throws(() => sheets.save('sheet_bad', {
    schemaVersion: 1, sheetId: 'sheet_bad', title: 'bad', kind: 'sketch',
    canvas: { width: 700, height: 900 }, strokes: [{ id: 'x', points: [{ x: NaN, y: 2 }] }],
  }, { baseRevisionId: initial.revisionId }), /bad point/);
  assert.throws(() => sheets.validateDocument('sheet_bad', {
    schemaVersion: 1, sheetId: 'sheet_bad', title: 'bad', kind: 'binary',
    canvas: { width: 700, height: 900 }, strokes: [],
  }), /unsupported sheet kind/);
});
