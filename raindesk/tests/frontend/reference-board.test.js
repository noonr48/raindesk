'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const refs = require('../../public/js/reference-board');
const sync = require('../../public/js/sheet-sync');

const index = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/reference-board.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../public/css/reference-board.css'), 'utf8');
const smoke = fs.readFileSync(path.join(__dirname, '../../dev/browser-reference-board-smoke.js'), 'utf8');

test('reference cards fit inside the sheet canvas without upscaling small images', () => {
  const wide = refs.fitImageCard(1600, 800, 900, 700);
  assert.ok(wide.width <= 900 * 0.62 + 0.001);
  assert.equal(Math.round(wide.width / wide.height), 2);
  const small = refs.fitImageCard(100, 50, 900, 700);
  assert.equal(small.width, 100);
  assert.equal(small.height, 50);
});

test('media CSS is expressed in document-relative coordinates and preserves rotation/opacity', () => {
  const style = refs.mediaCss({ x: 90, y: 70, width: 180, height: 140, rotation: 12, opacity: 0.5, zIndex: 3 }, { width: 900, height: 700 });
  assert.equal(style.left, '10%');
  assert.equal(style.top, '10%');
  assert.equal(style.width, '20%');
  assert.equal(style.height, '20%');
  assert.equal(style.transform, 'rotate(12deg)');
  assert.equal(style.opacity, '0.5');
});

test('reference board scripts load in concurrency-safe order before app boot', () => {
  assert.match(index, /api\.js[\s\S]*sheet-sync\.js[\s\S]*creative-desk\.js[\s\S]*reference-board\.js[\s\S]*app\.js/);
  assert.match(index, /reference-board\.css/);
});

test('reference board uses immutable blob upload, paste, arrange mode and revisioned sheet saves', () => {
  assert.match(source, /api\.uploadBlob\(converted\.bytes\)/);
  assert.match(source, /addEventListener\('paste'/);
  assert.match(source, /reference-arrange/);
  assert.match(source, /baseRevisionId: current\.revisionId/);
  assert.match(source, /kind: 'image', sha: asset\.sha/);
  assert.match(css, /reference-arrange \.creative-sheet-canvas \{ pointer-events:none/);
  assert.match(css, /reference-media-layer \{[^}]*z-index:2/);
  assert.equal(typeof sync.install, 'function');
});


test('Reference Board native acceptance pins import, arrange, draw-over merge and reload persistence', () => {
  assert.match(smoke, /DOM\.setFileInputFiles/);
  assert.match(smoke, /reference card move persistence/);
  assert.match(smoke, /reference resize persistence/);
  assert.match(smoke, /reference rotation persistence/);
  assert.match(smoke, /stroke \+ reference media orthogonal merge/);
  assert.match(smoke, /reference board document did not survive reload/);
});


test('reference board serializes media mutations per sheet so local transforms cannot race', async () => {
  let current = {
    sheetId: 'sheet_refs', revisionId: 'srev_0',
    document: { schemaVersion: 1, sheetId: 'sheet_refs', title: 'Refs', kind: 'references', canvas: { width: 900, height: 700 }, media: [], strokes: [], meta: {} },
  };
  let active = 0; let maxActive = 0; let saves = 0;
  const api = {
    async getSheet() { return JSON.parse(JSON.stringify(current)); },
    async saveSheet(_id, document, options) {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(options.baseRevisionId, current.revisionId);
      saves += 1;
      current = { sheetId: 'sheet_refs', revisionId: `srev_${saves}`, document: JSON.parse(JSON.stringify(document)) };
      active -= 1;
      return { revision: current };
    },
  };
  const board = refs.ReferenceBoard({ api, root: null, document: null });
  await Promise.all([
    board.saveDocument('sheet_refs', (doc) => doc.media.push({ id: 'a' }), 'first'),
    board.saveDocument('sheet_refs', (doc) => doc.media.push({ id: 'b' }), 'second'),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(current.document.media.length, 2);
});
