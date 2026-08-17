'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../../public/js/sheet-sync');

function revision(id, title = 'Refs', strokes = [], media = []) {
  return { revisionId: id, document: { schemaVersion: 1, sheetId: 'sheet_refs', title, kind: 'references', canvas: { width: 900, height: 700 }, media, strokes, meta: {} } };
}

test('sheet sync detects media-only server advances and merges current media into an incoming drawing edit', () => {
  const base = revision('srev_base');
  const current = revision('srev_current', 'Refs', [], [{ id: 'm', sha: 'a'.repeat(64) }]);
  const incoming = revision('local', 'Refs', [{ id: 's', points: [{ x: 1, y: 2 }] }], []).document;
  assert.equal(sync.sameExceptMedia(base.document, current.document), true);
  const merged = sync.mergeCurrentMedia(incoming, current.document);
  assert.equal(merged.strokes.length, 1);
  assert.equal(merged.media.length, 1);
});

test('sheet sync never calls a title/stroke conflict media-only', () => {
  const base = revision('srev_base');
  const titleChanged = revision('srev_title', 'New title');
  const strokeChanged = revision('srev_stroke', 'Refs', [{ id: 's', points: [{ x: 1, y: 2 }] }]);
  assert.equal(sync.sameExceptMedia(base.document, titleChanged.document), false);
  assert.equal(sync.sameExceptMedia(base.document, strokeChanged.document), false);
});


test('sheet sync refuses to overwrite an incoming stale media edit', async () => {
  const calls = [];
  const base = revision('srev_base', 'Refs', [], [{ id: 'm', sha: 'a'.repeat(64), rotation: 0 }]);
  const current = revision('srev_current', 'Refs', [], [{ id: 'm', sha: 'a'.repeat(64), rotation: 5 }]);
  const api = {
    async saveSheet(_id, document, options) {
      calls.push({ document, options });
      const e = new Error('stale'); e.status = 409; throw e;
    },
    async getSheet() { return current; },
    async getSheetRevision() { return base; },
  };
  sync.install(api);
  await assert.rejects(() => api.saveSheet('sheet_refs', {
    ...base.document,
    media: [{ ...base.document.media[0], rotation: -5 }],
  }, { baseRevisionId: base.revisionId, reason: 'rotate left' }), /stale/);
  assert.equal(calls.length, 1, 'stale media intent is not retried by the orthogonal merge bridge');
  assert.equal(sync.sameMedia(base.document, current.document), false);
});

test('sheet sync retries a 409 exactly once when the current revision only added media', async () => {
  const calls = [];
  const base = revision('srev_base');
  const current = revision('srev_current', 'Refs', [], [{ id: 'm', sha: 'a'.repeat(64) }]);
  const api = {
    async saveSheet(_id, document, options) {
      calls.push({ document, options });
      if (calls.length === 1) { const e = new Error('stale'); e.status = 409; throw e; }
      return { revision: revision('srev_merged', document.title, document.strokes, document.media) };
    },
    async getSheet() { return current; },
    async getSheetRevision() { return base; },
  };
  sync.install(api);
  const result = await api.saveSheet('sheet_refs', { ...base.document, strokes: [{ id: 's', points: [{ x: 4, y: 5 }] }] }, { baseRevisionId: base.revisionId, reason: 'draw' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.baseRevisionId, 'srev_current');
  assert.equal(calls[1].document.media.length, 1);
  assert.equal(result.revision.revisionId, 'srev_merged');
});
