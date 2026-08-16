'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BEATS = require('../../public/js/beats');

const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../../public/js/app.js'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '../../public/js/chat.js'), 'utf8');

 test('beat helpers prefer the artist raw wording and keep metadata lightweight', () => {
  const beat = { rawDirection: 'clicks tongue while shaking his fist', movement: { actor: 'Tom', timing: 'before the lunge' } };
  assert.equal(BEATS.beatLine(beat), 'clicks tongue while shaking his fist');
  assert.match(BEATS.beatMeta(beat), /Tom/);
  assert.match(BEATS.beatMeta(beat), /before the lunge/);
});

test('Beat Trail is loaded as a minimizable creative panel, not a fixed inspector', () => {
  assert.match(html, /data-tool="beats"/);
  assert.match(html, /id="beatTrail"/);
  assert.match(html, /js\/beats\.js/);
  assert.match(app, /RaindeskBeats/);
  assert.match(app, /state\.beatTrail\.toggle/);
});

test('ordinary Partner turns can refresh a visible Beat Trail', () => {
  assert.match(chat, /listeners = \{ open: \[\], close: \[\], turn: \[\] \}/);
  assert.match(chat, /listeners\.turn\.forEach/);
  assert.match(app, /state\.drawer\.on\(['"]turn['"]/);
});

test('Beat Trail pins raw artist wording before asking Partner to enrich it', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/beats.js'), 'utf8');
  const pinAt = source.indexOf('api.createDirectionBeat');
  const partnerAt = source.indexOf('await askPartner(v');
  assert.ok(pinAt !== -1 && partnerAt !== -1 && pinAt < partnerAt, 'raw beat save happens before Partner call');
  assert.match(source, /precreatedBeatId/);
  assert.match(source, /source: \{ kind: 'user_beat_trail' \}/);
});
