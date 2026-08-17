'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-characters-'));
process.env.RAINDESK_DATA_DIR = scratch;
const characters = require('../characters');

function anchor(id = 'front') {
  return { id, sha: 'c'.repeat(64), sheetId: 'sheet_character_primary', mediaId: `media_${id}`, view: id === 'front' ? 'front' : 'other', label: id };
}

test('locked character identity requires immutable anchor evidence', () => {
  assert.throws(() => characters.upsert({ id: 'anna', name: 'Anna', locked: true }), /requires at least one anchor/);
  const anna = characters.upsert({
    id: 'anna', name: 'Anna', aliases: ['Anna'], canonicalSheetId: 'sheet_character_primary',
    anchors: [anchor()], identityRules: ['teenager', 'two arms'], locked: true,
  });
  assert.equal(anna.locked, true);
  assert.equal(anna.anchors[0].sha, 'c'.repeat(64));
  assert.deepEqual(characters.list().map((item) => item.id), ['anna']);
});

test('character anchors reject bad hashes and duplicate anchor ids', () => {
  assert.throws(() => characters.upsert({ id: 'bad', anchors: [{ id: 'x', sha: 'bad' }] }), /bad blob sha/);
  assert.throws(() => characters.upsert({ id: 'dup', anchors: [anchor('same'), anchor('same')] }), /anchor ids must be unique/);
});

test('shot cast bindings validate character identity and return bounded anchor context', () => {
  characters.upsert({ id: 'tate', name: 'Tate', anchors: [anchor('tate')], locked: true });
  assert.throws(() => characters.bindShot('S01', ['missing']), /unknown character/);
  const ctx = characters.bindShot('S01', ['anna', 'tate', 'anna']);
  assert.deepEqual(ctx.characterIds, ['anna', 'tate']);
  assert.equal(ctx.characters.length, 2);
  assert.equal(ctx.characters[0].anchors[0].sha.length, 64);
  assert.equal(ctx.characters[0].identityRules.includes('two arms'), true);
});

test('rough shots can bind an unlocked character before visual identity is pinned', () => {
  const rough = characters.upsert({ id: 'mara', name: 'Mara', locked: false });
  assert.equal(rough.locked, false);
  const ctx = characters.bindShot('S02', ['mara']);
  assert.deepEqual(ctx.characterIds, ['mara']);
  assert.equal(ctx.characters[0].locked, false);
  assert.deepEqual(ctx.characters[0].anchors, []);
});
