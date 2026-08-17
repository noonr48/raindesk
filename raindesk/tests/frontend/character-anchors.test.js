'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const anchors = require('../../public/js/character-anchors');
const apiSource = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8');
const refSource = fs.readFileSync(path.join(__dirname, '../../public/js/reference-board.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const shotContextSource = fs.readFileSync(path.join(__dirname, '../../public/js/shot-context.js'), 'utf8');

function media(id, sha) { return { id, kind: 'image', sha, caption: id }; }

test('character sheet identity maps to a stable registry id and immutable media anchors', () => {
  assert.equal(anchors.characterIdForSheet('sheet_character_primary'), 'character_primary');
  const records = anchors.anchorRecordsFromMedia('sheet_character_primary', [media('front', 'a'.repeat(64)), media('bad', 'no')]);
  assert.equal(records.length, 1);
  assert.equal(records[0].sha, 'a'.repeat(64));
  assert.equal(records[0].mediaId, 'front');
});

test('locked identity becomes stale when the Character sheet image set changes', () => {
  const character = { locked: true, canonicalSheetId: 'sheet_character_primary', anchors: [{ sha: 'a'.repeat(64) }] };
  assert.equal(anchors.sameAnchorSet(character, { media: [media('front', 'a'.repeat(64))] }), true);
  assert.equal(anchors.sameAnchorSet(character, { media: [media('front', 'b'.repeat(64))] }), false);
});

test('character anchors wire registry REST, character media import, lock and shot binding before app boot', () => {
  assert.match(apiSource, /listCharacters/);
  assert.match(apiSource, /setShotCharacters/);
  assert.match(refSource, /\['references', 'character'\]\.includes/);
  assert.match(index, /reference-board\.js[\s\S]*character-anchors\.js[\s\S]*app\.js/);
  assert.match(index, /character-anchors\.css/);
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/character-anchors.js'), 'utf8');
  assert.match(source, /character-anchor-lock/);
  assert.match(source, /character-shot-bind/);
  assert.match(source, /update the pinned look|refresh identity lock/);
});

test('Character Anchors native acceptance pins lock staleness, explicit refresh and reload binding', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '../../dev/browser-character-anchors-smoke.js'), 'utf8');
  assert.match(smoke, /rough shot binding enabled/);
  assert.match(smoke, /explicit identity unpin/);
  assert.match(smoke, /stale identity lock warning/);
  assert.match(smoke, /identity authority silently changed/);
  assert.match(smoke, /explicit identity lock refresh/);
  assert.match(smoke, /Character identity\/binding did not survive reload/);
});

test('shot presence is independent from identity lock and refreshes from an explicit shot-change contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/character-anchors.js'), 'utf8');
  assert.match(source, /mount\.bind\.disabled = !shotId \|\| !record;/);
  assert.doesNotMatch(source, /mount\.bind\.disabled = !shotId \|\| !record \|\| !record\.locked/);
  assert.match(source, /raindesk:shot-change/);
  assert.match(source, /dataset\.raindeskShotId/);
  assert.match(shotContextSource, /dataset\.raindeskShotId/);
  assert.match(shotContextSource, /raindesk:shot-change/);
  assert.match(index, /shot-context\.js[\s\S]*character-anchors\.js[\s\S]*app\.js/);
});

test('a fresh pinned look can be deliberately unpinned while a stale pin refreshes explicitly', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/character-anchors.js'), 'utf8');
  assert.match(source, /const shouldUnlock = Boolean/);
  assert.match(source, /locked: !shouldUnlock/);
  assert.match(source, /current character look is pinned — click to unpin it/);
});
